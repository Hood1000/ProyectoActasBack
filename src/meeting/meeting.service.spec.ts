import prisma from '../prismaClient';
import { AttendanceStatus, MeetingCategory, MeetingMode, MeetingType } from '../../generated/prisma';
import { MailService } from '../mail/mail.service';
import { MeetingService } from './meeting.service';

jest.mock('puppeteer', () => ({ __esModule: true, default: {} }));
jest.mock('../prismaClient', () => ({
  __esModule: true,
  default: { attendance: { findMany: jest.fn(), updateMany: jest.fn() }, user: { findMany: jest.fn() }, meeting: { create: jest.fn() }, $transaction: jest.fn() },
}));

describe('Meeting email notifications', () => {
  const mail = { isConfigured: jest.fn(), send: jest.fn() };
  const service = new MeetingService(mail as unknown as MailService);
  const meeting = {
    id: 'meeting-id', date: new Date('2026-10-30T14:00:00Z'), location: 'Sala',
    modality: 'PRESENCIAL', title: 'Consejo', organizerId: 'organizer-id',
  };
  const teacher = { id: 'teacher-id', isActive: true, email: 'teacher@example.test', name: 'Teacher' };
  const alert = {
    absencesCount: 3, academicYear: 2026, meetingDate: meeting.date,
    meetingTitle: meeting.title, teacherName: teacher.name,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mail.isConfigured.mockReturnValue(true);
    mail.send.mockResolvedValue({});
    (prisma.attendance.findMany as jest.Mock).mockResolvedValue([{ user: teacher }, { user: teacher }]);
    (prisma.user.findMany as jest.Mock).mockResolvedValue([{ email: 'secretary@example.test' }]);
  });

  it('preserves the meeting subject and unique invited recipients', async () => {
    await service['sendMeetingEmailNotification'](meeting, 'created');
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(mail.send).toHaveBeenCalledWith(expect.objectContaining({
      subject: `Nueva reuni\u00f3n programada: ${meeting.title}`,
      to: teacher.email,
      html: expect.stringContaining(meeting.location),
    }));
  });

  it('records an absence without automatically issuing alerts or emails', async () => {
    const attendanceService = new MeetingService(mail as unknown as MailService);
    attendanceService['getMeetingOrThrow'] = jest.fn().mockResolvedValue({
      date: new Date(), isClosed: false, status: 'EN_CURSO',
      attendanceOpensAt: new Date(0), attendanceClosesAt: new Date(),
    });
    attendanceService['ensureAcademicYearOpenByDate'] = jest.fn();
    attendanceService['refreshQuorum'] = jest.fn().mockResolvedValue(undefined);
    attendanceService['triggerAbsenceThresholdAlerts'] = jest.fn();
    attendanceService.findOne = jest.fn().mockResolvedValue(null);
    (prisma.attendance.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    await attendanceService.markAttendance('meeting-id', 'teacher-id', { status: AttendanceStatus.AUSENTE });
    expect(attendanceService['triggerAbsenceThresholdAlerts']).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
    expect(prisma.attendance.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ excuse: null }) }));
  });

  it('creates default invitations for all active users atomically, preserving explicit invitation lists', async () => {
    const creationService = new MeetingService(mail as unknown as MailService);
    creationService['ensureAcademicYearOpenByDate'] = jest.fn();
    creationService['ensureMeetingSchedule'] = jest.fn();
    creationService['sendMeetingEmailNotification'] = jest.fn().mockResolvedValue(undefined);
    creationService['mapMeetingView'] = jest.fn();
    (prisma.$transaction as jest.Mock).mockImplementation((callback: (tx: typeof prisma) => unknown) => callback(prisma));
    const registeredUsers = [teacher, { id: 'secretary-id' }, { id: 'coordinator-id' }];
    (prisma.user.findMany as jest.Mock).mockResolvedValue(registeredUsers);
    const dto = { date: '2026-12-01T14:00:00Z', title: 'Consejo', location: 'Sala', meetingCategory: MeetingCategory.CONSEJO_CARRERA, meetingType: MeetingType.ORDINARIA, modality: MeetingMode.PRESENCIAL };
    await creationService.create('organizer', dto);
    expect(prisma.user.findMany).toHaveBeenCalledWith({ where: { isActive: true }, select: { id: true } });
    expect(prisma.meeting.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ attendance: { create: registeredUsers.map((registeredUser) => ({ userId: registeredUser.id, status: 'PENDIENTE' })) } }) }));
    (prisma.user.findMany as jest.Mock).mockClear();
    await creationService.create('organizer', { ...dto, invitedUserIds: [] });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.meeting.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ attendance: { create: [] } }) }));
    await creationService.create('organizer', { ...dto, invitedUserIds: [teacher.id] });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.meeting.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ attendance: { create: [{ userId: teacher.id, status: 'PENDIENTE' }] } }) }));
  });

  it('preserves the secretary recipients of absence alerts', async () => {
    await service['sendAbsenceAlertEmailNotification'](alert);
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { isActive: true, role: 'SECRETARIO' }, select: { email: true },
    });
    expect(mail.send).toHaveBeenCalledWith(expect.objectContaining({
      to: 'secretary@example.test', html: expect.stringContaining('2026'),
    }));
  });

  it('does not send existing notifications when SMTP is not configured', async () => {
    mail.isConfigured.mockReturnValue(false);
    await service['sendMeetingEmailNotification'](meeting, 'updated');
    await service['sendAbsenceAlertEmailNotification'](alert);
    expect(mail.send).not.toHaveBeenCalled();
    expect(prisma.attendance.findMany).not.toHaveBeenCalled();
  });

  it('keeps SMTP failures from failing meeting and absence operations', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      mail.send.mockRejectedValue(new Error('SMTP unavailable'));
      await expect(service['sendMeetingEmailNotification'](meeting, 'updated')).resolves.toBeUndefined();
      await expect(service['sendAbsenceAlertEmailNotification'](alert)).resolves.toBeUndefined();
      expect(errorLog).toHaveBeenCalledTimes(2);
    } finally {
      errorLog.mockRestore();
    }
  });
});