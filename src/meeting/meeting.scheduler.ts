import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Status } from '../../generated/prisma';
import { MeetingChatGateway } from './meeting-chat.gateway';
import { MeetingService } from './meeting.service';

/**
 * Mantiene el estado de las reuniones sin depender de que alguien abra el navegador:
 * cancela las que vencieron sin realizarse, pasa a "En curso" las que llegaron a su hora
 * y cierra la ventana de asistencia.
 */
@Injectable()
export class MeetingScheduler {
  private readonly logger = new Logger(MeetingScheduler.name);
  private isRunning = false;

  constructor(
    private readonly meetingService: MeetingService,
    private readonly meetingChatGateway: MeetingChatGateway,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async syncMeetings() {
    // Evita solapamientos si una corrida tarda mas de un minuto.
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const { cancelledMeetings, cancelledIds } = await this.meetingService.autoCancelExpiredMeetings();
      const { activatedMeetings, activatedIds, finalizedMeetings, failures } =
        await this.meetingService.syncAttendanceWindows();

      cancelledIds.forEach((id) =>
        this.meetingChatGateway.emitMeetingStatus({ id, status: Status.CANCELADA, isClosed: false, votingOpen: false }),
      );
      activatedIds.forEach((id) =>
        this.meetingChatGateway.emitMeetingStatus({ id, status: Status.EN_CURSO, isClosed: false, votingOpen: false }),
      );

      if (cancelledMeetings || activatedMeetings || finalizedMeetings) {
        this.logger.log(
          `Reuniones canceladas: ${cancelledMeetings}, en curso: ${activatedMeetings}, asistencia cerrada: ${finalizedMeetings}`,
        );
      }
      failures.forEach(({ id, error }) => this.logger.warn(`No se pudo cerrar la asistencia de ${id}: ${error}`));
    } catch (error) {
      this.logger.error(`Error sincronizando reuniones: ${(error as Error).message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
