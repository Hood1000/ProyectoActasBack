import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
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

  constructor(private readonly meetingService: MeetingService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async syncMeetings() {
    // Evita solapamientos si una corrida tarda mas de un minuto.
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const { cancelledMeetings } = await this.meetingService.autoCancelExpiredMeetings();
      const { activatedMeetings, finalizedMeetings } = await this.meetingService.syncAttendanceWindows();

      if (cancelledMeetings || activatedMeetings || finalizedMeetings) {
        this.logger.log(
          `Reuniones canceladas: ${cancelledMeetings}, en curso: ${activatedMeetings}, asistencia cerrada: ${finalizedMeetings}`,
        );
      }
    } catch (error) {
      this.logger.error(`Error sincronizando reuniones: ${(error as Error).message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
