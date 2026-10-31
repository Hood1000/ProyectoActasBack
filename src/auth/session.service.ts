import { Injectable, UnauthorizedException } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import prisma from '../prismaClient';

export type SessionPayload = {
  sub: string;
  email?: string;
  role?: string;
  authVersion?: number;
};

@Injectable()
export class SessionService {
  private readonly events = new EventEmitter();

  async validateTokenPayload(payload: SessionPayload) {
    if (!payload || typeof payload.sub !== 'string' ||
      (payload.authVersion !== undefined && (!Number.isInteger(payload.authVersion) || payload.authVersion < 0))) {
      throw new UnauthorizedException('Sesion no valida');
    }
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, role: true, isActive: true, authVersion: true },
    });
    if (!user?.isActive || user.authVersion !== (payload.authVersion ?? 0)) {
      throw new UnauthorizedException('Sesion vencida. Inicia sesion nuevamente.');
    }
    return { id: user.id, email: user.email, role: user.role, authVersion: user.authVersion };
  }

  onRevoked(listener: (userId: string) => void) {
    this.events.on('revoked', listener);
    return () => { this.events.off('revoked', listener); };
  }

  revokeUserSessions(userId: string) {
    this.events.emit('revoked', userId);
  }
}