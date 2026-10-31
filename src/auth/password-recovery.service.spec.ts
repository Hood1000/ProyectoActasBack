import { BadRequestException, INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import prisma from '../prismaClient';
import { MailService } from '../mail/mail.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordRecoveryService } from './password-recovery.service';
import { RecoveryRateLimitGuard } from './recovery-rate-limit.guard';
import { SessionService } from './session.service';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

jest.mock('../prismaClient', () => ({
  __esModule: true,
  default: { $transaction: jest.fn(), passwordResetToken: { updateMany: jest.fn() } },
}));
jest.mock('./session.service', () => ({ SessionService: class SessionService {} }), { virtual: true });
jest.mock('./auth.service', () => ({ AuthService: class AuthService {} }));
jest.mock('bcryptjs', () => ({ hash: jest.fn() }));

describe('Password recovery validation', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const token = 'a'.repeat(43);

  it('recorta el correo sin cambiar su capitalizacion', async () => {
    await expect(pipe.transform({ email: ' Teacher@example.test ' }, {
      type: 'body', metatype: ForgotPasswordDto,
    })).resolves.toEqual({ email: 'Teacher@example.test' });
  });

  it('rechaza campos desconocidos y correos invalidos', async () => {
    for (const body of [{ email: 'incorrecto' }, { email: 'a@example.test', admin: true }]) {
      await expect(pipe.transform(body, { type: 'body', metatype: ForgotPasswordDto })).rejects.toThrow();
    }
  });

  it('valida token, minimo de caracteres y maximo de bytes sin truncar', async () => {
    for (const body of [
      { token: 'a'.repeat(42), password: 'abcdef' },
      { token: '+'.repeat(43), password: 'abcdef' },
      { token, password: 'abcde' },
      { token, password: '\u00e9'.repeat(37) },
      { token, password: 'a'.repeat(73) },
      { token, password: 'abcdef', extra: true },
    ]) {
      await expect(pipe.transform(body, { type: 'body', metatype: ResetPasswordDto })).rejects.toThrow();
    }
    await expect(pipe.transform({ token, password: '\u00e9'.repeat(36) }, {
      type: 'body', metatype: ResetPasswordDto,
    })).resolves.toHaveProperty('password', '\u00e9'.repeat(36));
  });
});

describe('PasswordRecoveryService', () => {
  const originalEnvironment = { ...process.env };
  const token = 'a'.repeat(43);
  const user = { id: 'user-id', email: 'Teacher@example.test', isActive: true };
  const transaction = {
    user: { findUnique: jest.fn(), updateMany: jest.fn() },
    passwordResetToken: {
      findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn(),
    },
  };
  const mail = { isConfigured: jest.fn(), send: jest.fn() };
  const sessions = { revokeUserSessions: jest.fn() };
  let service: PasswordRecoveryService;
  let committed: boolean;
  let warning: jest.SpyInstance;

  const validRecord = () => ({
    id: 'reset-id', userId: user.id, user: { ...user },
    expiresAt: new Date(Date.now() + 60_000), usedAt: null, revokedAt: null,
  });

  beforeEach(() => {
    jest.resetAllMocks();
    committed = false;
    process.env = { ...originalEnvironment, FRONTEND_URL: 'https://actas.example.test/base' };
    warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    transaction.user.findUnique.mockResolvedValue({ ...user });
    transaction.user.updateMany.mockResolvedValue({ count: 1 });
    transaction.passwordResetToken.findFirst.mockResolvedValue(null);
    transaction.passwordResetToken.findUnique.mockImplementation(async () => validRecord());
    transaction.passwordResetToken.create.mockResolvedValue({ id: 'reset-id' });
    transaction.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
    mail.isConfigured.mockReturnValue(true);
    mail.send.mockResolvedValue({});
    (bcrypt.hash as jest.Mock).mockResolvedValue('hashed-password');
    (prisma.$transaction as jest.Mock).mockImplementation(async (operation) => {
      const result = await operation(transaction);
      committed = true;
      return result;
    });
    (prisma.passwordResetToken.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    service = new PasswordRecoveryService(mail as unknown as MailService, sessions as unknown as SessionService);
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(() => { process.env = originalEnvironment; });

  it('guarda solamente SHA256, vence en 30 minutos y envia solo al usuario tras commit', async () => {
    mail.send.mockImplementation(async () => {
      expect(committed).toBe(true);
    });
    const result = await service.forgotPassword(` ${user.email} `);
    expect(result).toEqual({ message: 'Si existe una cuenta habilitada, recibir\u00e1s las instrucciones para recuperar tu contrase\u00f1a.' });
    expect(transaction.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { email: user.email } }));
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
    const message = mail.send.mock.calls[0][0];
    expect(Object.keys(message).sort()).toEqual(['html', 'subject', 'text', 'to']);
    expect(message.html).toContain('Establecer una nueva contrase&ntilde;a');
    expect(message).not.toHaveProperty('cc');
    expect(message).not.toHaveProperty('bcc');
    expect(message.to).toBe(user.email);
    const link = new URL(message.text.match(/https:\/\/\S+/)[0]);
    expect(link.origin).toBe('https://actas.example.test');
    expect(link.pathname).toBe('/restablecer-contrasena');
    expect(link.search).toBe('');
    const plainToken = link.hash.slice('#token='.length);
    expect(plainToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = transaction.passwordResetToken.create.mock.calls[0][0].data;
    expect(Object.keys(stored).sort()).toEqual(['createdAt', 'expiresAt', 'tokenHash', 'userId']);
    expect(stored.tokenHash).toBe(createHash('sha256').update(plainToken).digest('hex'));
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBe(1_800_000);
    expect(transaction.passwordResetToken.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: user.id, usedAt: null, revokedAt: null },
    }));
    expect(transaction.user.updateMany).not.toHaveBeenCalled();
    expect(sessions.revokeUserSessions).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(plainToken);
  });

  it('normaliza la respuesta para inexistente, inactivo, cooldown y SMTP sin configurar', async () => {
    const baseline = await service.forgotPassword(user.email);
    for (const found of [null, { ...user, isActive: false }, user]) {
      mail.send.mockClear();
      transaction.passwordResetToken.create.mockClear();
      transaction.user.findUnique.mockResolvedValue(found);
      transaction.passwordResetToken.findFirst.mockResolvedValue({ id: 'recent' });
      await expect(service.forgotPassword(user.email)).resolves.toEqual(baseline);
      expect(mail.send).not.toHaveBeenCalled();
      expect(transaction.passwordResetToken.create).not.toHaveBeenCalled();
    }
    mail.isConfigured.mockReturnValue(false);
    await expect(service.forgotPassword(user.email)).resolves.toEqual(baseline);
    expect(transaction.passwordResetToken.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ revokedAt: null, createdAt: { gte: expect.any(Date) } }),
    }));
  });

  it('revoca el token tras fallo SMTP sin registrar datos privados y permite reintentar', async () => {
    mail.send.mockRejectedValueOnce(new Error('private SMTP details'));
    const result = await service.forgotPassword(user.email);
    expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
      where: { id: 'reset-id', usedAt: null, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(warning).toHaveBeenCalledWith('No se pudo enviar el correo de recuperacion.');
    expect(JSON.stringify(warning.mock.calls)).not.toMatch(/Teacher|private|https/);
    await expect(service.forgotPassword(user.email)).resolves.toEqual(result);
    expect(mail.send).toHaveBeenCalledTimes(2);
  });

  it.each([
    undefined, '', 'not-a-url', 'ftp://actas.example.test',
    'https://user:pass@actas.example.test', 'https://actas.example.test?query=1',
    'https://actas.example.test#fragment', 'https://actas.example.test?',
    'https://actas.example.test#',
  ])('no emite tokens con FRONTEND_URL insegura (%s)', async (url) => {
    if (url === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = url;
    await expect(service.forgotPassword(user.email)).resolves.toHaveProperty('message');
    expect(transaction.passwordResetToken.create).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('acepta http configurado sin usar cabeceras de peticion', async () => {
    process.env.FRONTEND_URL = 'http://actas.example.test';
    await service.forgotPassword(user.email);
    expect(mail.send.mock.calls[0][0].text).toContain('http://actas.example.test/restablecer-contrasena#token=');
  });

  it('reintenta P2034 y reconsulta el cooldown antes de emitir', async () => {
    (prisma.$transaction as jest.Mock).mockRejectedValueOnce({ code: 'P2034' });
    transaction.passwordResetToken.findFirst.mockResolvedValue({ id: 'concurrent-token' });
    await service.forgotPassword(user.email);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('acota reintentos y conserva respuesta generica ante errores de persistencia', async () => {
    (prisma.$transaction as jest.Mock).mockRejectedValue({ code: 'P2034' });
    await expect(service.forgotPassword(user.email)).resolves.toHaveProperty('message');
    expect(prisma.$transaction).toHaveBeenCalledTimes(4);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('solo envia un correo en dos solicitudes con transacciones serializadas', async () => {
    let issued = false;
    let queue = Promise.resolve();
    transaction.passwordResetToken.findFirst.mockImplementation(async () => issued ? { id: 'recent' } : null);
    transaction.passwordResetToken.create.mockImplementation(async () => {
      issued = true;
      return { id: 'reset-id' };
    });
    (prisma.$transaction as jest.Mock).mockImplementation((operation) => {
      const result = queue.then(() => operation(transaction));
      queue = result.then(() => undefined, () => undefined);
      return result;
    });
    const results = await Promise.all([
      service.forgotPassword(user.email), service.forgotPassword(user.email),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(transaction.passwordResetToken.create).toHaveBeenCalledTimes(1);
  });

  it('no filtra errores si tambien falla revocar el token tras error SMTP', async () => {
    mail.send.mockRejectedValue(new Error('private-error'));
    (prisma.passwordResetToken.updateMany as jest.Mock).mockRejectedValue(new Error('private-database-error'));
    await expect(service.forgotPassword(user.email)).resolves.toHaveProperty('message');
    expect(JSON.stringify(warning.mock.calls)).not.toContain('private');
    expect(transaction.user.updateMany).not.toHaveBeenCalled();
  });

  it('consume, actualiza clave/version y revoca otros tokens antes del evento postcommit', async () => {
    sessions.revokeUserSessions.mockImplementation(() => expect(committed).toBe(true));
    await expect(service.resetPassword(token, 'new-password')).resolves.toEqual({
      message: 'Contrase\u00f1a restablecida. Ya puedes iniciar sesi\u00f3n.',
    });
    expect(bcrypt.hash).toHaveBeenCalledWith('new-password', 10);
    expect(transaction.passwordResetToken.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { tokenHash: createHash('sha256').update(token).digest('hex') },
    }));
    expect(transaction.passwordResetToken.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'reset-id', usedAt: null, revokedAt: null, expiresAt: { gt: expect.any(Date) }, user: { isActive: true } },
      data: { usedAt: expect.any(Date) },
    });
    expect(transaction.user.updateMany).toHaveBeenCalledWith({
      where: { id: user.id, isActive: true },
      data: { password: 'hashed-password', authVersion: { increment: 1 } },
    });
    expect(transaction.passwordResetToken.updateMany).toHaveBeenNthCalledWith(2, {
      where: { userId: user.id, id: { not: 'reset-id' }, usedAt: null, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(sessions.revokeUserSessions).toHaveBeenCalledTimes(1);
    expect(sessions.revokeUserSessions).toHaveBeenCalledWith(user.id);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('rechaza igual token inexistente, usado, revocado, vencido o cuenta inactiva', async () => {
    const errors: string[] = [];
    for (const record of [
      null, { ...validRecord(), usedAt: new Date() }, { ...validRecord(), revokedAt: new Date() },
      { ...validRecord(), expiresAt: new Date(0) },
      { ...validRecord(), user: { ...user, isActive: false } },
    ]) {
      transaction.passwordResetToken.findUnique.mockResolvedValue(record);
      try {
        await service.resetPassword(token, 'new-password');
        throw new Error('No se rechazo el token');
      } catch (error) {
        if (!(error instanceof BadRequestException)) throw error;
        expect(error.getStatus()).toBe(400);
        errors.push(error.message);
      }
    }
    expect(new Set(errors).size).toBe(1);
    expect(transaction.user.updateMany).not.toHaveBeenCalled();
    expect(sessions.revokeUserSessions).not.toHaveBeenCalled();
  });

  it('rechaza consumo perdido por concurrencia antes de modificar la clave', async () => {
    transaction.passwordResetToken.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.resetPassword(token, 'new-password')).rejects.toThrow('El enlace');
    expect(transaction.user.updateMany).not.toHaveBeenCalled();
    expect(sessions.revokeUserSessions).not.toHaveBeenCalled();
  });

  it('no emite evento si falla clave o invalidacion, y el error aborta la transaccion', async () => {
    transaction.user.updateMany.mockRejectedValueOnce(new Error('database-failure'));
    await expect(service.resetPassword(token, 'new-password')).rejects.toThrow('database-failure');
    expect(committed).toBe(false);
    expect(sessions.revokeUserSessions).not.toHaveBeenCalled();
    transaction.passwordResetToken.updateMany.mockResolvedValueOnce({ count: 1 }).mockRejectedValueOnce(new Error('revoke-failure'));
    await expect(service.resetPassword(token, 'new-password')).rejects.toThrow('revoke-failure');
    expect(committed).toBe(false);
    expect(sessions.revokeUserSessions).not.toHaveBeenCalled();
  });

  it('reintenta conflictos de reset sin emitir antes del commit ni duplicar el evento', async () => {
    (prisma.$transaction as jest.Mock).mockRejectedValueOnce({ code: 'P2034' });
    await service.resetPassword(token, 'new-password');
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(bcrypt.hash).toHaveBeenCalledTimes(1);
    expect(sessions.revokeUserSessions).toHaveBeenCalledTimes(1);
  });

  it('no notifica sesiones si falla el commit despues de todas las escrituras', async () => {
    (prisma.$transaction as jest.Mock).mockImplementation(async (operation) => {
      await operation(transaction);
      throw new Error('commit-failure');
    });
    await expect(service.resetPassword(token, 'new-password')).rejects.toThrow('commit-failure');
    expect(transaction.passwordResetToken.updateMany).toHaveBeenCalledTimes(2);
    expect(sessions.revokeUserSessions).not.toHaveBeenCalled();
  });

  it('aborta si la cuenta deja de estar activa al actualizar la clave', async () => {
    transaction.user.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.resetPassword(token, 'new-password')).rejects.toThrow('El enlace');
    expect(committed).toBe(false);
    expect(sessions.revokeUserSessions).not.toHaveBeenCalled();
  });

  it('solo permite un reset en dos peticiones concurrentes con transacciones serializadas', async () => {
    let used = false;
    let queue = Promise.resolve();
    transaction.passwordResetToken.findUnique.mockImplementation(async () => ({
      ...validRecord(), usedAt: used ? new Date() : null,
    }));
    transaction.passwordResetToken.updateMany.mockImplementation(async ({ data }) => {
      if (data.usedAt) used = true;
      return { count: 1 };
    });
    (prisma.$transaction as jest.Mock).mockImplementation((operation) => {
      const result = queue.then(() => operation(transaction));
      queue = result.then(() => undefined, () => undefined);
      return result;
    });
    const results = await Promise.allSettled([
      service.resetPassword(token, 'new-password'), service.resetPassword(token, 'new-password'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(transaction.user.updateMany).toHaveBeenCalledTimes(1);
    expect(sessions.revokeUserSessions).toHaveBeenCalledTimes(1);
  });

  it('aplica limites de password tambien cuando se llama al servicio directamente', async () => {
    for (const password of ['short', 'a'.repeat(73), '\u00e9'.repeat(37)]) {
      await expect(service.resetPassword(token, password)).rejects.toThrow('72 bytes');
    }
    await expect(service.resetPassword('invalid', 'new-password')).rejects.toThrow('El enlace');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(bcrypt.hash).not.toHaveBeenCalled();
  });
});

describe('Public recovery endpoints', () => {
  let app: INestApplication;
  const recovery = {
    forgotPassword: jest.fn().mockResolvedValue({ message: 'respuesta generica' }),
    resetPassword: jest.fn().mockResolvedValue({ message: 'clave restablecida' }),
  };

  beforeAll(async () => {
    recovery.forgotPassword.mockResolvedValue({ message: 'respuesta generica' });
    recovery.resetPassword.mockResolvedValue({ message: 'clave restablecida' });
    const module = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: {} },
        { provide: PasswordRecoveryService, useValue: recovery },
        RecoveryRateLimitGuard,
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app?.close(); });

  it('acepta ambos POST sin JWT ni rol de administrador y responde 200', async () => {
    await request(app.getHttpServer()).post('/auth/forgot-password')
      .send({ email: ' Teacher@example.test ' }).expect(200).expect({ message: 'respuesta generica' });
    expect(recovery.forgotPassword).toHaveBeenCalledWith('Teacher@example.test');
    await request(app.getHttpServer()).post('/auth/reset-password')
      .send({ token: 'a'.repeat(43), password: 'new-password' }).expect(200)
      .expect({ message: 'clave restablecida' });
  });

  it('rechaza datos adicionales y password de mas de 72 bytes desde HTTP', async () => {
    await request(app.getHttpServer()).post('/auth/forgot-password')
      .send({ email: 'user@example.test', cc: 'admin@example.test' }).expect(400);
    await request(app.getHttpServer()).post('/auth/reset-password')
      .send({ token: 'a'.repeat(43), password: '\u00e9'.repeat(37) }).expect(400);
  });
});