import { ForbiddenException } from '@nestjs/common';
import { MeetingChatGateway } from './meeting-chat.gateway';

describe('MeetingChatGateway', () => {
  let gateway: MeetingChatGateway;
  let jwtService: { verify: jest.Mock };
  let meetingService: { ensureUserCanAccessMeetingContext: jest.Mock };

  const buildClient = (token?: string) => ({
    handshake: { auth: { token } },
    data: {} as Record<string, unknown>,
    recovered: false,
    disconnect: jest.fn(),
    join: jest.fn(),
    leave: jest.fn(),
  });

  beforeEach(() => {
    jwtService = { verify: jest.fn() };
    meetingService = { ensureUserCanAccessMeetingContext: jest.fn() };
    gateway = new MeetingChatGateway(jwtService as any, meetingService as any);
  });

  it('stores the JWT user on connection', () => {
    const client = buildClient('valid');
    jwtService.verify.mockReturnValue({ sub: 'user-1', email: 'a@b.c', role: 'DOCENTE' });

    gateway.handleConnection(client as any);

    expect(client.data.user).toEqual({ id: 'user-1', email: 'a@b.c', role: 'DOCENTE' });
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('disconnects sockets with an invalid token', () => {
    const client = buildClient('bad');
    jwtService.verify.mockImplementation(() => {
      throw new Error('invalid');
    });

    gateway.handleConnection(client as any);

    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('joins the meeting room when the user has access', async () => {
    const client = buildClient();
    client.data.user = { id: 'user-1', role: 'DOCENTE' };

    const ack = await gateway.joinMeeting(client as any, { meetingId: 'meeting-1' });

    expect(meetingService.ensureUserCanAccessMeetingContext).toHaveBeenCalledWith('meeting-1', 'user-1', 'DOCENTE');
    expect(client.join).toHaveBeenCalledWith('meeting:meeting-1');
    expect(ack).toEqual({ ok: true });
  });

  it('rejects the join when the user is not invited', async () => {
    const client = buildClient();
    client.data.user = { id: 'user-2', role: 'DOCENTE' };
    meetingService.ensureUserCanAccessMeetingContext.mockRejectedValue(new ForbiddenException('sin acceso'));

    const ack = await gateway.joinMeeting(client as any, { meetingId: 'meeting-1' });

    expect(client.join).not.toHaveBeenCalled();
    expect(ack).toEqual({ ok: false, error: 'sin acceso' });
  });

  it('emits new chat messages only to the meeting room', () => {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    gateway.server = { to } as any;
    const message = { id: 'msg-1', meetingId: 'meeting-1' };

    gateway.emitChatMessage('meeting-1', message);

    expect(to).toHaveBeenCalledWith('meeting:meeting-1');
    expect(emit).toHaveBeenCalledWith('chat:new', message);
  });

  it('emits poll updates only to the meeting room', () => {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    gateway.server = { to } as any;
    const poll = { id: 'poll-1', meetingId: 'meeting-1', results: { total: 1 } };

    gateway.emitPollUpdate('meeting-1', poll);

    expect(to).toHaveBeenCalledWith('meeting:meeting-1');
    expect(emit).toHaveBeenCalledWith('poll:update', poll);
  });
});
