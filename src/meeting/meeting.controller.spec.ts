import { Test } from '@nestjs/testing';
import { MeetingController } from './meeting.controller';
import { MeetingService } from './meeting.service';
import { MeetingChatGateway } from './meeting-chat.gateway';
import { StorageService } from '../storage/storage.service';

jest.mock('puppeteer', () => ({ __esModule: true, default: {} }));

describe('MeetingController', () => {
  let controller: MeetingController;
  let meetingService: {
    closeMeeting: jest.Mock;
    confirmAttendanceForUser: jest.Mock;
    ensureEvidenceUploadAllowed: jest.Mock;
    postMeetingChatMessage: jest.Mock;
    setEvidenceReference: jest.Mock;
    startVoting: jest.Mock;
    voteMeetingPoll: jest.Mock;
  };
  let meetingChatGateway: { emitChatMessage: jest.Mock; emitMeetingStatus: jest.Mock; emitPollUpdate: jest.Mock };
  let storageService: { deleteQuietly: jest.Mock; upload: jest.Mock };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MeetingController],
      providers: [
        {
          provide: MeetingService,
          useValue: {
            closeMeeting: jest.fn(),
            confirmAttendanceForUser: jest.fn(),
            ensureEvidenceUploadAllowed: jest.fn(),
            postMeetingChatMessage: jest.fn(),
            setEvidenceReference: jest.fn(),
            startVoting: jest.fn(),
            voteMeetingPoll: jest.fn(),
          },
        },
        {
          provide: MeetingChatGateway,
          useValue: {
            emitChatMessage: jest.fn(),
            emitMeetingStatus: jest.fn(),
            emitPollUpdate: jest.fn(),
          },
        },
        {
          provide: StorageService,
          useValue: {
            deleteQuietly: jest.fn(),
            upload: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = moduleRef.get(MeetingController);
    meetingService = moduleRef.get(MeetingService);
    meetingChatGateway = moduleRef.get(MeetingChatGateway);
    storageService = moduleRef.get(StorageService);
  });

  it('delegates attendance confirmation to the authenticated user', async () => {
    const req = { user: { id: 'user-1' } };
    meetingService.confirmAttendanceForUser.mockResolvedValue({ ok: true });

    await controller.confirmAttendance(req as any, 'meeting-1');

    expect(meetingService.confirmAttendanceForUser).toHaveBeenCalledWith('meeting-1', 'user-1');
  });

  it('broadcasts the created chat message to the meeting room', async () => {
    const req = { user: { id: 'user-1', role: 'DOCENTE' } };
    const created = { id: 'msg-1', meetingId: 'meeting-1', content: 'Hola' };
    meetingService.postMeetingChatMessage.mockResolvedValue(created);

    const result = await controller.postMeetingChatMessage(req as any, 'meeting-1', { content: 'Hola' });

    expect(result).toBe(created);
    expect(meetingChatGateway.emitChatMessage).toHaveBeenCalledWith('meeting-1', created);
  });

  it('does not broadcast when the message could not be saved', async () => {
    const req = { user: { id: 'user-1', role: 'DOCENTE' } };
    meetingService.postMeetingChatMessage.mockRejectedValue(new Error('forbidden'));

    await expect(controller.postMeetingChatMessage(req as any, 'meeting-1', { content: 'Hola' })).rejects.toThrow();
    expect(meetingChatGateway.emitChatMessage).not.toHaveBeenCalled();
  });

  it('broadcasts the updated poll after a vote', async () => {
    const req = { user: { id: 'user-1', role: 'DOCENTE' } };
    const poll = { id: 'poll-1', results: { aFavor: 1, enContra: 0, abstencion: 0, total: 1 } };
    meetingService.voteMeetingPoll.mockResolvedValue(poll);

    const result = await controller.voteMeetingPoll(req as any, 'meeting-1', 'poll-1', { option: 'A_FAVOR' } as any);

    expect(meetingService.voteMeetingPoll).toHaveBeenCalledWith('meeting-1', 'poll-1', 'user-1', 'DOCENTE', {
      option: 'A_FAVOR',
    });
    expect(meetingChatGateway.emitPollUpdate).toHaveBeenCalledWith('meeting-1', poll);
    expect(result).toBe(poll);
  });

  it('broadcasts the new status when voting starts', async () => {
    const meeting = { id: 'meeting-1', status: 'EN_CURSO', isClosed: false, votingOpen: true };
    meetingService.startVoting.mockResolvedValue(meeting);

    await controller.startVoting({ user: { id: 'sec-1' } } as any, 'meeting-1');

    expect(meetingService.startVoting).toHaveBeenCalledWith('meeting-1', 'sec-1');
    expect(meetingChatGateway.emitMeetingStatus).toHaveBeenCalledWith(meeting);
  });

  it('broadcasts the final status when the meeting is closed', async () => {
    const meeting = { id: 'meeting-1', status: 'FINALIZADA', isClosed: true, votingOpen: false };
    meetingService.closeMeeting.mockResolvedValue(meeting);

    const result = await controller.closeMeeting('meeting-1');

    expect(result).toBe(meeting);
    expect(meetingChatGateway.emitPollUpdate).not.toHaveBeenCalled();
    expect(meetingChatGateway.emitMeetingStatus).toHaveBeenCalledWith(meeting);
  });

  it('rejects evidence whose content is not a supported file, even with a valid mimetype', async () => {
    const file = { buffer: Buffer.from('MZ fake executable'), mimetype: 'application/pdf' } as any;

    await expect(controller.uploadEvidenceFile('meeting-1', file)).rejects.toThrow('no corresponde');
    expect(storageService.upload).not.toHaveBeenCalled();
  });

  it('uploads valid evidence and removes the replaced file', async () => {
    const file = { buffer: Buffer.from('%PDF-1.7 contenido'), mimetype: 'application/pdf' } as any;
    storageService.upload.mockResolvedValue('gs://bucket/meetings/meeting-1/evidence/x.pdf');
    meetingService.setEvidenceReference.mockResolvedValue({ meeting: { id: 'meeting-1' }, previousReference: '/uploads/evidence/old.pdf' });

    await controller.uploadEvidenceFile('meeting-1', file);

    expect(meetingService.ensureEvidenceUploadAllowed).toHaveBeenCalledWith('meeting-1');
    expect(storageService.upload).toHaveBeenCalledWith(
      file.buffer,
      expect.stringMatching(/^meetings\/meeting-1\/evidence\/[0-9a-f-]+\.pdf$/),
      'application/pdf',
    );
    expect(storageService.deleteQuietly).toHaveBeenCalledWith('/uploads/evidence/old.pdf');
  });

  it('deletes the uploaded object if the meeting changed state during the upload', async () => {
    const file = { buffer: Buffer.from('%PDF-1.7 contenido'), mimetype: 'application/pdf' } as any;
    storageService.upload.mockResolvedValue('gs://bucket/meetings/meeting-1/evidence/x.pdf');
    meetingService.setEvidenceReference.mockRejectedValue(new Error('cerrada'));

    await expect(controller.uploadEvidenceFile('meeting-1', file)).rejects.toThrow('cerrada');
    expect(storageService.deleteQuietly).toHaveBeenCalledWith('gs://bucket/meetings/meeting-1/evidence/x.pdf');
  });
});
