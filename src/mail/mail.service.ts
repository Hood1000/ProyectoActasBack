import { Injectable } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import * as nodemailer from 'nodemailer';
import type { SendMailOptions } from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';

@Injectable()
export class MailService {
  isConfigured() {
    if (process.env.MAIL_TRANSPORT === 'gmail-api') {
      return Boolean(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN && process.env.GMAIL_FROM);
    }
    if (process.env.MAIL_TRANSPORT && process.env.MAIL_TRANSPORT !== 'smtp') return false;
    return Boolean(process.env.SMTP_HOST && (process.env.SMTP_FROM || process.env.SMTP_USER));
  }

  async send(options: SendMailOptions) {
    if (process.env.MAIL_TRANSPORT === 'gmail-api') return this.sendWithGmail(options);
    if (process.env.MAIL_TRANSPORT && process.env.MAIL_TRANSPORT !== 'smtp') {
      throw new Error('Transporte de correo no reconocido');
    }
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT || 587);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const from = process.env.SMTP_FROM || user;

    if (!host || !from || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Configuracion SMTP incompleta');
    }
    if (Boolean(user) !== Boolean(pass)) {
      throw new Error('Las credenciales SMTP deben configurarse juntas');
    }

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      ...(user && pass ? { auth: { user, pass } } : {}),
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10000,
    });
    try {
      return await transporter.sendMail({ ...options, from });
    } finally {
      transporter.close();
    }
  }

  private async sendWithGmail(options: SendMailOptions) {
    if (!this.isConfigured()) throw new Error('Configuracion Gmail API incompleta');

    try {
      const client = new OAuth2Client({
        clientId: process.env.GMAIL_CLIENT_ID,
        clientSecret: process.env.GMAIL_CLIENT_SECRET,
        transporterOptions: { timeout: 10000, retry: false },
      });
      client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
      const compiledMessage = new MailComposer({ ...options, from: process.env.GMAIL_FROM }).compile();
      compiledMessage.keepBcc = true;
      const message = await compiledMessage.build();
      const response = await client.request<{ id?: string }>({
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        method: 'POST',
        data: { raw: message.toString('base64url') },
        timeout: 15000,
        retry: false,
      });
      if (!response.data.id) throw new Error('Respuesta Gmail API incompleta');
      return { messageId: response.data.id };
    } catch {
      throw new Error('No se pudo enviar el correo mediante Gmail API');
    }
  }
}