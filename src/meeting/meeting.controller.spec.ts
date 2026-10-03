import { Test } from '@nestjs/testing';
import { MeetingController } from './meeting.controller';
import { MeetingService } from './meeting.service';

describe('MeetingController', () => {
  let controller: MeetingController;
  let meetingService: { confirmAttendanceForUser: jest.Mock };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MeetingController],
      providers: [
        {
          provide: MeetingService,
          useValue: {
            confirmAttendanceForUser: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = moduleRef.get(MeetingController);
    meetingService = moduleRef.get(MeetingService);
  });

  it('delegates attendance confirmation to the authenticated user', async () => {
    const req = { user: { id: 'user-1' } };
    meetingService.confirmAttendanceForUser.mockResolvedValue({ ok: true });

    await controller.confirmAttendance(req as any, 'meeting-1');

    expect(meetingService.confirmAttendanceForUser).toHaveBeenCalledWith('meeting-1', 'user-1');
  });
});
