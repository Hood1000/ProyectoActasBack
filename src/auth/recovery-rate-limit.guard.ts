import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';

@Injectable()
export class RecoveryRateLimitGuard implements CanActivate {
  static readonly deploymentScope = 'Memoria local acotada para una sola instancia; varias instancias requieren un almacen compartido.';
  private readonly entries = new Map<string, { count: number; expiresAt: number }>();
  private readonly maxEntries = 10_000;
  private readonly windowMs = 15 * 60_000;

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    const route = context.getHandler().name;
    const keys: { key: string; limit: number }[] = [{
      key: `${route}:ip:${request.ip || request.socket?.remoteAddress || 'unknown'}`,
      limit: 20,
    }];
    const body = request.body as Record<string, unknown> | undefined;
    const email = body?.email;
    const token = body?.token;
    if (typeof email === 'string') {
      keys.push({
        key: `email:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`,
        limit: 5,
      });
    } else if (typeof token === 'string') {
      keys.push({
        key: `token:${createHash('sha256').update(token).digest('hex')}`,
        limit: 5,
      });
    }
    const newEntries = keys.filter(({ key }) => !this.entries.has(key)).length;
    if (this.entries.size + newEntries > this.maxEntries ||
      keys.some(({ key, limit }) => (this.entries.get(key)?.count ?? 0) >= limit)) {
      response.setHeader('Retry-After', Math.ceil(this.windowMs / 1000));
      throw new HttpException('Demasiados intentos. Intenta de nuevo mas tarde.', HttpStatus.TOO_MANY_REQUESTS);
    }
    for (const { key } of keys) {
      const entry = this.entries.get(key) ?? { count: 0, expiresAt: now + this.windowMs };
      entry.count += 1;
      this.entries.set(key, entry);
    }
    return true;
  }
}