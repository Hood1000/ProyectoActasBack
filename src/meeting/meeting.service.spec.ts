import prisma from '../prismaClient';
import { MailService } from '../mail/mail.service';
import { MeetingService } from './meeting.service';

jest.mock('puppeteer', () => ({ __esModule: true, default: {} }));
jest.mock('../prismaClient', () => ({
  __esModule: true,
  default: { attendance: { findMany: jest.fn() }, user: { findMany: jest.fn() } },
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