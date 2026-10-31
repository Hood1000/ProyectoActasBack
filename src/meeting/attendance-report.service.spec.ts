import { AttendanceStatus, Prisma } from '../../generated/prisma';
import prisma from '../prismaClient';
import { AttendanceReportService } from './attendance-report.service';
import { attendanceScope, attendanceTotals } from './attendance-report.utils';
import { AttendanceReportQueryDto } from './dto/attendance-report.dto';
import { scopeMeetingAttendance } from './meeting-attendance.interceptor';
import { ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AttendanceReportController } from './attendance-report.controller';
import { RolesGuard } from '../auth/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

jest.mock('../prismaClient', () => ({ __esModule: true, default: {
  user: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  attendance: { findMany: jest.fn(), groupBy: jest.fn() },
  absenceAlert: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
  $transaction: jest.fn(),
} }));

describe('Attendance reports and manual warnings', () => {
  const service = new AttendanceReportService();
  const teacher = { id: 'teacher', name: 'Docente', cedula: '123', isActive: true };
  const issuer = { id: 'secretary', name: 'Secretaria' };
  const absences = [1, 2, 3].map((number) => ({ id: `attendance-${number}`, userId: teacher.id, status: 'AUSENTE', excuse: null, meeting: { id: `meeting-${number}`, title: 'Consejo', date: new Date('2026-09-10T14:00:00Z') } }));
  const dto = { year: 2026, content: 'Llamado de atencion por tres faltas injustificadas.' };

  beforeEach(() => {
    jest.resetAllMocks();
    (prisma.$transaction as jest.Mock).mockImplementation((callback: (tx: typeof prisma) => unknown) => callback(prisma));
    (prisma.user.findFirst as jest.Mock).mockImplementation(({ where }: { where: { role: string } }) => Promise.resolve(where.role === 'DOCENTE' ? teacher : issuer));
    (prisma.absenceAlert.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.attendance.findMany as jest.Mock).mockResolvedValue(absences);
    (prisma.absenceAlert.create as jest.Mock).mockResolvedValue({ id: 'warning' });
  });

  it('uses Caracas month boundaries and excludes future, cancelled and unfinalized meetings', () => {
    const scope = attendanceScope(2026, 10, new Date('2026-10-31T12:00:00Z'));
    expect(scope).toMatchObject({ user: { role: 'DOCENTE' }, meeting: { attendanceFinalized: true, status: { not: 'CANCELADA' }, date: {
      gte: new Date('2026-10-01T04:00:00Z'), lt: new Date('2026-11-01T04:00:00Z'), lte: new Date('2026-10-31T12:00:00Z'),
    } } });
    expect(() => attendanceScope(undefined, 10)).toThrow('ano');
    expect(attendanceScope(2026, 12)).toMatchObject({ meeting: { date: { lt: new Date('2027-01-01T04:00:00Z') } } });
  });

  it('prevents historical attendance exposure through generic meeting responses', () => {
    const meeting = { id: 'meeting', isClosed: true, attendance: [{ userId: 'teacher' }, { userId: 'other' }] };
    expect(scopeMeetingAttendance([meeting], { id: 'secretary', role: 'SECRETARIO' })).toEqual([{ ...meeting, attendance: [] }]);
    expect(scopeMeetingAttendance(meeting, { id: 'admin', role: 'ADMIN' })).toEqual(meeting);
    expect(scopeMeetingAttendance({ ...meeting, isClosed: false }, { id: 'teacher', role: 'DOCENTE' })).toEqual({ ...meeting, isClosed: false, attendance: [{ userId: 'teacher' }] });
  });

  it('counts justified absences in the denominator, not as presence, and returns null for no data', () => {
    expect(attendanceTotals([]).percentage).toBeNull();
    expect(attendanceTotals([
      { status: AttendanceStatus.PRESENTE, _count: { _all: 8 } },
      { status: AttendanceStatus.AUSENTE, _count: { _all: 1 } },
      { status: AttendanceStatus.JUSTIFICADA, _count: { _all: 1 } },
      { status: AttendanceStatus.PENDIENTE, _count: { _all: 4 } },
    ])).toEqual({ present: 8, absent: 1, justified: 1, total: 10, percentage: 80 });
  });

  it('includes disabled teachers and limits summary aggregation to the requested page', async () => {
    (prisma.user.count as jest.Mock).mockResolvedValue(1);
    (prisma.user.findMany as jest.Mock).mockResolvedValue([{ ...teacher, isActive: false }]);
    (prisma.attendance.groupBy as jest.Mock).mockResolvedValue([{ userId: teacher.id, status: 'PRESENTE', _count: { _all: 2 } }]);
    const result = await service.summary(new AttendanceReportQueryDto());
    expect(result.items[0].percentage).toBe(100);
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { role: 'DOCENTE' }, take: 20 }));
    expect(prisma.attendance.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: { in: ['teacher'] } }) }));
  });

  it('persists issuer and a fixed snapshot only on manual issuance', async () => {
    await service.issue(teacher.id, issuer.id, dto);
    expect(prisma.absenceAlert.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      issuedById: issuer.id, issuedAt: expect.any(Date), summary: dto.content, absencesCount: 3,
      evidence: expect.objectContaining({ teacher, issuer, absences: expect.arrayContaining([expect.objectContaining({ attendanceId: 'attendance-1' })]) }),
    }) }));
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
  });

  it('revalidates threshold and refuses emission with fewer than three unjustified absences', async () => {
    (prisma.attendance.findMany as jest.Mock).mockResolvedValue(absences.slice(0, 2));
    await expect(service.issue(teacher.id, issuer.id, dto)).rejects.toThrow('3 inasistencias');
    expect(prisma.absenceAlert.create).not.toHaveBeenCalled();
    expect(prisma.attendance.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'AUSENTE', OR: [{ excuse: null }, { excuse: '' }] }) }));
  });

  it('refuses duplicate yearly cases and non-secretary issuers', async () => {
    (prisma.absenceAlert.findUnique as jest.Mock).mockResolvedValue({ issuedAt: new Date() });
    await expect(service.issue(teacher.id, issuer.id, dto)).rejects.toThrow('ya tiene');
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(service.issue(teacher.id, 'admin', dto)).rejects.toThrow('Solo Secretaria');
    expect(prisma.absenceAlert.create).not.toHaveBeenCalled();
  });

  it('retries serialization conflicts and converts unique races to conflict errors', async () => {
    (prisma.$transaction as jest.Mock).mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('retry', { code: 'P2034', clientVersion: '7' }));
    await expect(service.issue(teacher.id, issuer.id, dto)).resolves.toEqual({ id: 'warning' });
    (prisma.$transaction as jest.Mock).mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: '7' }));
    await expect(service.issue(teacher.id, issuer.id, dto)).rejects.toThrow('ya fue emitido');
  });

  it('scopes teacher lists to their own warnings and rejects another teachers document', async () => {
    (prisma.absenceAlert.count as jest.Mock).mockResolvedValue(0);
    (prisma.absenceAlert.findMany as jest.Mock).mockResolvedValue([]);
    await service.warnings(new AttendanceReportQueryDto(), { id: teacher.id, role: 'DOCENTE' });
    expect(prisma.absenceAlert.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { teacherId: teacher.id, issuedAt: { not: null } } }));
    (prisma.absenceAlert.findFirst as jest.Mock).mockResolvedValue({ teacherId: 'other' });
    await expect(service.warning('warning', { id: teacher.id, role: 'DOCENTE' })).rejects.toThrow('otro docente');
  });
});

describe('Attendance report HTTP permissions', () => {
  let app: INestApplication;
  const teacherId = 'c052fa88-0593-4ee9-ad90-48798beb2271';

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AttendanceReportController],
      providers: [RolesGuard, { provide: AttendanceReportService, useValue: {
        summary: () => ({}), history: () => ({}), cases: () => ({}),
        issue: () => ({}), warnings: () => ({}), warning: () => ({}),
      } }],
    }).overrideGuard(JwtAuthGuard).useValue({ canActivate(context: ExecutionContext) {
      const req = context.switchToHttp().getRequest<{ headers: Record<string, string>; user: { id: string; role: string } }>();
      if (!req.headers['x-test-role']) throw new UnauthorizedException();
      req.user = { id: teacherId, role: req.headers['x-test-role'] };
      return true;
    } }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => { await app.close(); });

  it.each(['SECRETARIO', 'DOCENTE'])('denies complete history to %s', async (role) => {
    await request(app.getHttpServer()).get('/meetings/attendance/history').set('x-test-role', role).expect(403);
    await request(app.getHttpServer()).get(`/meetings/attendance/history/${teacherId}`).set('x-test-role', role).expect(403);
  });

  it('allows ADMIN history and denies unauthenticated access and invalid filters', async () => {
    await request(app.getHttpServer()).get('/meetings/attendance/history').set('x-test-role', 'ADMIN').expect(200);
    await request(app.getHttpServer()).get('/meetings/attendance/history').expect(401);
    await request(app.getHttpServer()).get('/meetings/attendance/history?limit=1000').set('x-test-role', 'ADMIN').expect(400);
    await request(app.getHttpServer()).get('/meetings/attendance/history?teacherId=other').set('x-test-role', 'ADMIN').expect(400);
  });

  it('restricts operational cases and manual issuance to the agreed roles', async () => {
    await request(app.getHttpServer()).get('/meetings/absence-cases').set('x-test-role', 'DOCENTE').expect(403);
    await request(app.getHttpServer()).get('/meetings/absence-cases').set('x-test-role', 'SECRETARIO').expect(200);
    await request(app.getHttpServer()).post(`/meetings/absence-cases/${teacherId}/warning`).set('x-test-role', 'ADMIN').send({ year: 2026, content: 'Llamado de atencion registrado por Secretaria.' }).expect(403);
    await request(app.getHttpServer()).post(`/meetings/absence-cases/${teacherId}/warning`).set('x-test-role', 'SECRETARIO').send({ year: 2026, content: 'Llamado de atencion registrado por Secretaria.' }).expect(201);
    await request(app.getHttpServer()).get('/meetings/warnings?teacherId=other').set('x-test-role', 'DOCENTE').expect(400);
  });
});