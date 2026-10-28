import { ForbiddenException } from '@nestjs/common';
import { MeetingChatGateway } from './meeting-chat.gateway';

describe('MeetingChatGateway', () => {
  let gateway: MeetingChatGateway;
  let jwtService: { verify: jest.Mock };
  let meetingService: { ensureUserCanAccessMeetingChat: jest.Mock };

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
    meetingService = { ensureUserCanAccessMeetingChat: jest.fn() };
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

    expect(meetingService.ensureUserCanAccessMeetingChat).toHaveBeenCalledWith('meeting-1', 'user-1', 'DOCENTE');
    expect(client.join).toHaveBeenCalledWith('meeting:meeting-1');
    expect(ack).toEqual({ ok: true });
  });

  it('rejects the join when the user is not invited', async () => {
    const client = buildClient();
    client.data.user = { id: 'user-2', role: 'DOCENTE' };
    meetingService.ensureUserCanAccessMeetingChat.mockRejectedValue(new ForbiddenException('sin acceso'));

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

  it('removes participants (but not managers) from the room when the meeting closes', async () => {
    const emit = jest.fn();
    const docente = { data: { user: { id: 'd', role: 'DOCENTE' } }, leave: jest.fn() };
    const secretaria = { data: { user: { id: 's', role: 'SECRETARIO' } }, leave: jest.fn() };
    gateway.server = {
      to: jest.fn().mockReturnValue({ emit }),
      in: jest.fn().mockReturnValue({ fetchSockets: jest.fn().mockResolvedValue([docente, secretaria]) }),
    } as any;

    gateway.emitMeetingStatus({ id: 'meeting-1', status: 'FINALIZADA', isClosed: true, votingOpen: false });
    await new Promise((resolve) => setImmediate(resolve));

    expect(emit).toHaveBeenCalledWith('meeting:status', expect.objectContaining({ status: 'FINALIZADA' }));
    expect(docente.leave).toHaveBeenCalledWith('meeting:meeting-1');
    expect(secretaria.leave).not.toHaveBeenCalled();
  });

  it('keeps everyone in the room while the meeting is still running', () => {
    const inFn = jest.fn();
    gateway.server = { to: jest.fn().mockReturnValue({ emit: jest.fn() }), in: inFn } as any;

    gateway.emitMeetingStatus({ id: 'meeting-1', status: 'EN_CURSO', isClosed: false, votingOpen: true });

    expect(inFn).not.toHaveBeenCalled();
  });
});
