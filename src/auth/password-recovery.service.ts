import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import type { Prisma } from '../../generated/prisma';
import prisma from '../prismaClient';
import { MailService } from '../mail/mail.service';
import { describeMailError } from '../mail/mail-error';
import { renderEmail } from '../mail/mail-template';
import { SessionService } from './session.service';

const recoveryMessage = 'Si existe una cuenta habilitada, recibir\u00e1s las instrucciones para recuperar tu contrase\u00f1a.';
const resetMessage = 'Contrase\u00f1a restablecida. Ya puedes iniciar sesi\u00f3n.';
const invalidMessage = 'El enlace no es valido o ha caducado. Solicita uno nuevo.';

@Injectable()
export class PasswordRecoveryService {
  private readonly logger = new Logger(PasswordRecoveryService.name);

  constructor(
    private readonly mailService: MailService,
    private readonly sessionService: SessionService,
  ) {}

  private async transaction<Result>(
    operation: (transaction: Prisma.TransactionClient) => Promise<Result>,
  ): Promise<Result> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await prisma.$transaction(operation, { isolationLevel: 'Serializable' });
      } catch (error: unknown) {
        if (attempt >= 3 || !error || typeof error !== 'object' ||
          !('code' in error) || error.code !== 'P2034') {
          throw error;
        }
      }
    }
  }

  private recoveryUrl(token: string): string {
    const configuredUrl = process.env.FRONTEND_URL;
    if (!configuredUrl) throw new Error('Configuracion de recuperacion incompleta');
    const url = new URL(configuredUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || configuredUrl.includes('?') || configuredUrl.includes('#')) {
      throw new Error('Configuracion de recuperacion invalida');
    }
    url.pathname = '/restablecer-contrasena';
    url.hash = `token=${token}`;
    return url.toString();
  }

  async forgotPassword(email: string): Promise<{ message: string }> {
    const response = { message: recoveryMessage };
    try {
      const token = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const url = this.recoveryUrl(token);
      const configured = this.mailService.isConfigured();
      const issued = await this.transaction(async (transaction) => {
        const user = await transaction.user.findUnique({
          where: { email: email.trim() },
          select: { id: true, email: true, isActive: true },
        });
        if (!user?.isActive || !configured) return null;
        const now = new Date();
        const recent = await transaction.passwordResetToken.findFirst({
          where: {
            userId: user.id,
            revokedAt: null,
            createdAt: { gte: new Date(now.getTime() - 60_000) },
          },
          select: { id: true },
        });
        if (recent) return null;
        await transaction.passwordResetToken.updateMany({
          where: { userId: user.id, usedAt: null, revokedAt: null },
          data: { revokedAt: now },
        });
        const record = await transaction.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash,
            createdAt: now,
            expiresAt: new Date(now.getTime() + 30 * 60_000),
          },
          select: { id: true },
        });
        return { id: record.id, email: user.email };
      });
      if (!configured) this.logger.warn('Transporte de correo no configurado; no se envio la recuperacion.');
      if (!issued) return response;
      const { html, text } = renderEmail({
        preheader: 'Usa este enlace para crear una nueva contraseña. Vence en 30 minutos.',
        eyebrow: 'Seguridad de la cuenta',
        title: 'Restablece tu contraseña',
        paragraphs: [
          'Recibimos una solicitud para recuperar el acceso a tu cuenta del **Sistema de Actas**.',
          'Pulsa el botón para crear una nueva contraseña:',
        ],
        action: { label: 'Establecer una nueva contraseña', url, showFallbackLink: true },
        note: 'El enlace vence en **30 minutos** y solo puede usarse una vez. Si no lo solicitaste, ignora este correo: tu contraseña no cambiará hasta que confirmes una nueva.',
      });
      try {
        await this.mailService.send({
          to: issued.email,
          subject: 'Recuperación de contraseña - Sistema de Actas',
          html,
          text,
        });
      } catch (error: unknown) {
        this.logger.warn(`No se pudo enviar el correo de recuperacion: ${describeMailError(error)}.`);
        await prisma.passwordResetToken.updateMany({
          where: { id: issued.id, usedAt: null, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
    } catch (error: unknown) {
      this.logger.warn(`No se pudo completar la solicitud de recuperacion: ${describeMailError(error)}.`);
    }
    return response;
  }

  async resetPassword(token: string, password: string): Promise<{ message: string }> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new BadRequestException(invalidMessage);
    }
    if (typeof password !== 'string' || Array.from(password).length < 6 ||
      Buffer.byteLength(password, 'utf8') > 72) {
      throw new BadRequestException('La contrasena debe tener al menos 6 caracteres y no superar 72 bytes UTF-8.');
    }
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = await this.transaction(async (transaction) => {
      const record = await transaction.passwordResetToken.findUnique({
        where: { tokenHash },
        include: { user: { select: { id: true, isActive: true } } },
      });
      const now = new Date();
      if (!record || record.usedAt || record.revokedAt || record.expiresAt <= now ||
        !record.user.isActive) {
        throw new BadRequestException(invalidMessage);
      }
      const consumed = await transaction.passwordResetToken.updateMany({
        where: {
          id: record.id,
          usedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
          user: { isActive: true },
        },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) throw new BadRequestException(invalidMessage);
      const updated = await transaction.user.updateMany({
        where: { id: record.userId, isActive: true },
        data: { password: hashedPassword, authVersion: { increment: 1 } },
      });
      if (updated.count !== 1) throw new BadRequestException(invalidMessage);
      await transaction.passwordResetToken.updateMany({
        where: { userId: record.userId, id: { not: record.id }, usedAt: null, revokedAt: null },
        data: { revokedAt: now },
      });
      return record.userId;
    });
    try {
      this.sessionService.revokeUserSessions(userId);
    } catch {
      this.logger.warn('No se pudo notificar el cierre de sesiones.');
    }
    return { message: resetMessage };
  }
}