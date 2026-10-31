import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { MeetingService } from './meeting.service';
import { SessionService, type SessionPayload } from '../auth/session.service';

type SocketUser = { id: string; email: string; role: string; authVersion: number };

const meetingRoom = (meetingId: string) => `meeting:${meetingId}`;

// Mismo criterio que enableCors en main.ts; se evalua en runtime porque el decorador
// se ejecuta antes de que dotenv cargue las variables.
const corsOrigin = (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
  const configuredOrigins = process.env.CORS_ORIGINS?.split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (!configuredOrigins || configuredOrigins.length === 0 || !origin) {
    return callback(null, true);
  }
  callback(null, configuredOrigins.includes(origin));
};

@WebSocketGateway({
  cors: { origin: corsOrigin, credentials: true },
  connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 },
})
export class MeetingChatGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MeetingChatGateway.name);
  private unsubscribeRevocation?: () => void;

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly meetingService: MeetingService,
    private readonly sessionService: SessionService,
  ) {}

  onModuleInit() {
    this.unsubscribeRevocation = this.sessionService.onRevoked((userId) => {
      this.server?.in(`session:${userId}`).disconnectSockets(true);
    });
  }

  onModuleDestroy() {
    this.unsubscribeRevocation?.();
  }

  async handleConnection(client: Socket) {
    const token = client.handshake.auth?.token;
    try {
      const payload = this.jwtService.verify<SessionPayload>(token);
      const user = await this.sessionService.validateTokenPayload(payload);
      client.data.user = user satisfies SocketUser;
      await client.join(`session:${user.id}`);
      await this.sessionService.validateTokenPayload(payload);
    } catch {
      delete client.data.user;
      client.disconnect(true);
    }
  }

  @SubscribeMessage('meeting:join')
  async joinMeeting(@ConnectedSocket() client: Socket, @MessageBody() body: { meetingId?: string }) {
    const user = client.data.user as SocketUser | undefined;
    const meetingId = body?.meetingId;
    if (!user || !meetingId) {
      return { ok: false, error: 'Solicitud invalida' };
    }

    try {
      const current = await this.sessionService.validateTokenPayload({ sub: user.id, authVersion: user.authVersion });
      await this.meetingService.ensureUserCanAccessMeetingChat(meetingId, current.id, current.role);
      await client.join(meetingRoom(meetingId));
      return { ok: true };
    } catch (error) {
      this.logger.debug(`join rechazado ${meetingId} (${user.id}): ${(error as Error).message}`);
      return { ok: false, error: (error as Error).message };
    }
  }

  @SubscribeMessage('meeting:leave')
  async leaveMeeting(@ConnectedSocket() client: Socket, @MessageBody() body: { meetingId?: string }) {
    if (body?.meetingId) {
      await client.leave(meetingRoom(body.meetingId));
    }
    return { ok: true };
  }

  emitChatMessage(meetingId: string, message: unknown) {
    this.server?.to(meetingRoom(meetingId)).emit('chat:new', message);
  }

  emitPollUpdate(meetingId: string, poll: unknown) {
    this.server?.to(meetingRoom(meetingId)).emit('poll:update', poll);
  }

  // Avisa el cambio de estado (inicio de votacion, cierre, cancelacion) para que los
  // clientes bloqueen el chat y las votaciones sin esperar a recargar.
  emitMeetingStatus(meeting: { id: string; status: string; isClosed: boolean; votingOpen: boolean }) {
    this.server?.to(meetingRoom(meeting.id)).emit('meeting:status', {
      meetingId: meeting.id,
      status: meeting.status,
      isClosed: meeting.isClosed,
      votingOpen: meeting.votingOpen,
    });

    if (meeting.isClosed || meeting.status === 'FINALIZADA' || meeting.status === 'CANCELADA') {
      void this.removeParticipantsFromRoom(meeting.id);
    }
  }

  // Con la reunion cerrada solo Secretaria y Coordinacion siguen en la sala (lectura); los
  // docentes dejan de recibir eventos aunque tengan la pantalla abierta.
  private async removeParticipantsFromRoom(meetingId: string) {
    if (!this.server) return;
    try {
      const sockets = await this.server.in(meetingRoom(meetingId)).fetchSockets();
      for (const socket of sockets) {
        const role = (socket.data.user as SocketUser | undefined)?.role;
        if (role !== 'ADMIN' && role !== 'SECRETARIO') {
          socket.leave(meetingRoom(meetingId));
        }
      }
    } catch (error) {
      this.logger.warn(`No se pudo vaciar la sala ${meetingId}: ${(error as Error).message}`);
    }
  }
}
