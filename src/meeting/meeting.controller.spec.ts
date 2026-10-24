import { Test } from '@nestjs/testing';
import { MeetingController } from './meeting.controller';
import { MeetingService } from './meeting.service';
import { MeetingChatGateway } from './meeting-chat.gateway';

describe('MeetingController', () => {
  let controller: MeetingController;
  let meetingService: {
    confirmAttendanceForUser: jest.Mock;
    postMeetingChatMessage: jest.Mock;
    voteMeetingPoll: jest.Mock;
  };
  let meetingChatGateway: { emitChatMessage: jest.Mock; emitPollUpdate: jest.Mock };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MeetingController],
      providers: [
        {
          provide: MeetingService,
          useValue: {
            confirmAttendanceForUser: jest.fn(),
            postMeetingChatMessage: jest.fn(),
            voteMeetingPoll: jest.fn(),
          },
        },
        {
          provide: MeetingChatGateway,
          useValue: {
            emitChatMessage: jest.fn(),
            emitPollUpdate: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = moduleRef.get(MeetingController);
    meetingService = moduleRef.get(MeetingService);
    meetingChatGateway = moduleRef.get(MeetingChatGateway);
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
});
