import { ExecutionContext } from '@nestjs/common';
import { RecoveryRateLimitGuard } from './recovery-rate-limit.guard';

describe('RecoveryRateLimitGuard', () => {
  let guard: RecoveryRateLimitGuard;
  const setHeader = jest.fn();
  const context = (ip: string, body: unknown, handler = 'forgotPassword') => ({
    switchToHttp: () => ({
      getRequest: () => ({ ip, body, socket: {} }),
      getResponse: () => ({ setHeader }),
    }),
    getHandler: () => ({ name: handler }),
  }) as unknown as ExecutionContext;

  beforeEach(() => {
    guard = new RecoveryRateLimitGuard();
    jest.useFakeTimers();
    setHeader.mockClear();
  });
  afterEach(() => jest.useRealTimers());

  it('limita correo normalizado incluso desde diferentes IP', () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(guard.canActivate(context(`ip-${attempt}`, { email: ' Teacher@example.test ' }))).toBe(true);
    }
    expect(() => guard.canActivate(context('another-ip', { email: 'teacher@example.test' }))).toThrow('Demasiados intentos');
    expect(setHeader).toHaveBeenCalledWith('Retry-After', 900);
  });

  it('limita IP aunque cambie el correo y no acepta IP de cabeceras', () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      guard.canActivate(context('same-ip', { email: `user-${attempt}@example.test` }));
    }
    expect(() => guard.canActivate(context('same-ip', { email: 'different@example.test' }))).toThrow('Demasiados intentos');
  });

  it('limita tambien tokens de reset sin autenticar', () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      guard.canActivate(context(`ip-${attempt}`, { token: 'a'.repeat(43) }, 'resetPassword'));
    }
    expect(() => guard.canActivate(context('other-ip', { token: 'a'.repeat(43) }, 'resetPassword'))).toThrow('Demasiados intentos');
  });

  it('limita IP de reset aunque cambie el token', () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      guard.canActivate(context('same-ip', { token: `token-${attempt}` }, 'resetPassword'));
    }
    expect(() => guard.canActivate(context('same-ip', { token: 'different' }, 'resetPassword'))).toThrow('Demasiados intentos');
  });

  it('limpia expirados sin timers y permite nuevos intentos', () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      guard.canActivate(context('same-ip', { email: 'user@example.test' }));
    }
    jest.setSystemTime(Date.now() + 900_001);
    expect(guard.canActivate(context('same-ip', { email: 'user@example.test' }))).toBe(true);
  });

  it('mantiene memoria acotada sin desalojar limites vigentes al saturarse', () => {
    Reflect.set(guard, 'maxEntries', 4);
    guard.canActivate(context('ip-1', { email: 'first@example.test' }));
    guard.canActivate(context('ip-2', { email: 'second@example.test' }));
    expect(() => guard.canActivate(context('ip-3', { email: 'third@example.test' }))).toThrow('Demasiados intentos');
    expect(guard.canActivate(context('ip-1', { email: 'first@example.test' }))).toBe(true);
    jest.setSystemTime(Date.now() + 900_001);
    expect(guard.canActivate(context('ip-3', { email: 'third@example.test' }))).toBe(true);
  });
});