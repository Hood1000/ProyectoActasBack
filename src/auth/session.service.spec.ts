import prisma from '../prismaClient';
import { SessionService } from './session.service';

jest.mock('../prismaClient', () => ({ __esModule: true, default: { user: { findUnique: jest.fn() } } }));

describe('SessionService', () => {
  const service = new SessionService();
  const findUnique = prisma.user.findUnique as jest.Mock;
  const user = { id: 'user-1', email: 'teacher@example.test', role: 'DOCENTE', isActive: true, authVersion: 0 };

  beforeEach(() => { jest.clearAllMocks(); findUnique.mockResolvedValue(user); });

  it('accepts legacy tokens only while the account version is zero', async () => {
    await expect(service.validateTokenPayload({ sub: user.id })).resolves.toEqual({ id: user.id, email: user.email, role: user.role, authVersion: 0 });
    findUnique.mockResolvedValue({ ...user, authVersion: 1 });
    await expect(service.validateTokenPayload({ sub: user.id })).rejects.toThrow('Sesion vencida');
  });

  it('rejects sessions after a reset and accepts the current version', async () => {
    findUnique.mockResolvedValue({ ...user, authVersion: 2 });
    await expect(service.validateTokenPayload({ sub: user.id, authVersion: 1 })).rejects.toThrow();
    await expect(service.validateTokenPayload({ sub: user.id, authVersion: 2 })).resolves.toHaveProperty('authVersion', 2);
  });

  it('rejects missing and inactive users and malformed versions', async () => {
    findUnique.mockResolvedValue(null);
    await expect(service.validateTokenPayload({ sub: user.id })).rejects.toThrow();
    findUnique.mockResolvedValue({ ...user, isActive: false });
    await expect(service.validateTokenPayload({ sub: user.id })).rejects.toThrow();
    await expect(service.validateTokenPayload({ sub: user.id, authVersion: -1 })).rejects.toThrow();
  });

  it('reads the current role rather than trusting old claims', async () => {
    await expect(service.validateTokenPayload({ sub: user.id, role: 'ADMIN' })).resolves.toHaveProperty('role', 'DOCENTE');
  });

  it('notifies only the recovered account and releases listeners', () => {
    const listener = jest.fn();
    const unsubscribe = service.onRevoked(listener);
    service.revokeUserSessions(user.id);
    expect(listener).toHaveBeenCalledWith(user.id);
    unsubscribe();
    service.revokeUserSessions(user.id);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});