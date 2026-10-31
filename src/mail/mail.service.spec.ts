import { OAuth2Client } from 'google-auth-library';
import * as nodemailer from 'nodemailer';
import { MailService } from './mail.service';

jest.mock('google-auth-library', () => ({ OAuth2Client: jest.fn() }));
jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

describe('MailService', () => {
  const originalEnvironment = { ...process.env };
  const sendMail = jest.fn().mockResolvedValue({ messageId: 'local' });
  const close = jest.fn();
  const request = jest.fn();
  const setCredentials = jest.fn();
  const service = new MailService();

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnvironment, SMTP_HOST: '127.0.0.1', SMTP_PORT: '1025', SMTP_FROM: 'actas@example.test' };
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.MAIL_TRANSPORT;
    delete process.env.GMAIL_CLIENT_ID;
    delete process.env.GMAIL_CLIENT_SECRET;
    delete process.env.GMAIL_REFRESH_TOKEN;
    delete process.env.GMAIL_FROM;
    request.mockReset().mockResolvedValue({ data: { id: 'gmail-message' } });
    (OAuth2Client as unknown as jest.Mock).mockImplementation(() => ({ request, setCredentials }));
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail, close });
  });

  afterAll(() => { process.env = originalEnvironment; });

  it('sends through Mailpit without authentication or implicit TLS', async () => {
    await service.send({ to: 'teacher@example.test', text: 'test' });
    expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: '127.0.0.1', port: 1025, secure: false }));
    expect((nodemailer.createTransport as jest.Mock).mock.calls[0][0]).not.toHaveProperty('auth');
    expect(sendMail).toHaveBeenCalledWith({ from: 'actas@example.test', to: 'teacher@example.test', text: 'test' });
    expect(close).toHaveBeenCalled();
  });

  it('preserves authenticated SMTP and TLS on port 465', async () => {
    process.env.SMTP_USER = 'smtp-user';
    process.env.SMTP_PASS = 'smtp-password';
    process.env.SMTP_PORT = '465';
    await service.send({ to: 'teacher@example.test', text: 'test' });
    expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({ auth: { user: 'smtp-user', pass: 'smtp-password' }, secure: true }));
  });

  it('rejects partial credentials and missing sender', async () => {
    process.env.SMTP_PASS = 'smtp-password';
    await expect(service.send({ text: 'test' })).rejects.toThrow('credenciales');
    delete process.env.SMTP_PASS;
    delete process.env.SMTP_FROM;
    await expect(service.send({ text: 'test' })).rejects.toThrow('incompleta');
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it('propagates delivery failures and closes the transport', async () => {
    sendMail.mockRejectedValueOnce(new Error('SMTP unavailable'));
    await expect(service.send({ text: 'test' })).rejects.toThrow('SMTP unavailable');
    expect(close).toHaveBeenCalled();
  });

  describe('Gmail API', () => {
    beforeEach(() => {
      process.env.MAIL_TRANSPORT = 'gmail-api';
      process.env.GMAIL_CLIENT_ID = 'oauth-client';
      process.env.GMAIL_CLIENT_SECRET = 'oauth-secret';
      process.env.GMAIL_REFRESH_TOKEN = 'refresh-token';
      process.env.GMAIL_FROM = 'Sistema de Actas <sender@example.test>';
    });

    it('sends one MIME message over HTTPS with only the requested recipient', async () => {
      expect(service.isConfigured()).toBe(true);
      await expect(service.send({
        from: 'ignored@example.test',
        to: 'teacher@example.test',
        subject: 'Recuperacion de contrasena',
        text: 'Enlace privado',
        html: '<p>Enlace privado</p>',
      })).resolves.toEqual({ messageId: 'gmail-message' });

      expect(OAuth2Client).toHaveBeenCalledWith({
        clientId: 'oauth-client', clientSecret: 'oauth-secret', transporterOptions: { timeout: 10000, retry: false },
      });
      expect(setCredentials).toHaveBeenCalledWith({ refresh_token: 'refresh-token' });
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith(expect.objectContaining({
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        method: 'POST', timeout: 15000, retry: false,
      }));
      const raw = request.mock.calls[0][0].data.raw as string;
      expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
      const message = Buffer.from(raw, 'base64url').toString('utf8');
      expect(message).toContain('From: Sistema de Actas <sender@example.test>');
      expect(message).toContain('To: teacher@example.test');
      expect(message).toContain('Content-Type: multipart/alternative');
      expect(message).toContain('Content-Type: text/plain; charset=utf-8');
      expect(message).toContain('Content-Type: text/html; charset=utf-8');
      expect(message).toContain('Enlace privado');
      expect(message).not.toMatch(/^(?:Cc|Bcc):/im);
      expect(message).not.toContain('ignored@example.test');
      expect(message).not.toContain('refresh-token');
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });

    it('preserves explicit CC and BCC for other existing email workflows', async () => {
      await service.send({
        to: 'teacher@example.test', cc: 'reviewer@example.test', bcc: 'private@example.test', text: 'Meeting invitation',
      });
      const message = Buffer.from(request.mock.calls[0][0].data.raw as string, 'base64url').toString('utf8');
      expect(message).toContain('To: teacher@example.test');
      expect(message).toContain('Cc: reviewer@example.test');
      expect(message).toContain('Bcc: private@example.test');
      expect(request).toHaveBeenCalledTimes(1);
    });

    it.each(['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN', 'GMAIL_FROM'])('rejects missing %s without falling back to SMTP', async (key) => {
      delete process.env[key];
      expect(service.isConfigured()).toBe(false);
      await expect(service.send({ to: 'teacher@example.test', text: 'test' })).rejects.toThrow('incompleta');
      expect(request).not.toHaveBeenCalled();
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });

    it('sanitizes OAuth and delivery failures without retrying or falling back to SMTP', async () => {
      request.mockRejectedValueOnce(new Error('Authorization: Bearer private-token; raw: private-link'));
      await expect(service.send({ to: 'teacher@example.test', text: 'test' })).rejects.toThrow(/^No se pudo enviar el correo mediante Gmail API$/);
      expect(request).toHaveBeenCalledTimes(1);
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });

    it('rejects an incomplete Gmail API response', async () => {
      request.mockResolvedValueOnce({ data: {} });
      await expect(service.send({ to: 'teacher@example.test', text: 'test' })).rejects.toThrow('No se pudo enviar');
    });
  });

  it('rejects unknown transports instead of silently sending through SMTP', async () => {
    process.env.MAIL_TRANSPORT = 'unknown';
    expect(service.isConfigured()).toBe(false);
    await expect(service.send({ text: 'test' })).rejects.toThrow('no reconocido');
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});