import { Module, OnModuleInit } from '@nestjs/common';
import { MeetingService } from './meeting.service';
import { MeetingController } from './meeting.controller';
import { MeetingChatGateway } from './meeting-chat.gateway';
import { MeetingScheduler } from './meeting.scheduler';
import { RolesGuard } from '../auth/roles.guard';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { SessionModule } from '../auth/session.module';
import { AttendanceReportController } from './attendance-report.controller';
import { AttendanceReportService } from './attendance-report.service';
import { MeetingAttendancePrivacyInterceptor } from './meeting-attendance.interceptor';

@Module({
  imports: [AuthModule, MailModule, SessionModule],
  controllers: [AttendanceReportController, MeetingController],
  providers: [MeetingService, MeetingChatGateway, MeetingScheduler, RolesGuard, AttendanceReportService, MeetingAttendancePrivacyInterceptor],
  exports: [MeetingService],
})
export class MeetingModule implements OnModuleInit {
  constructor(private readonly meetingScheduler: MeetingScheduler) {}

  async onModuleInit() {
    await this.meetingScheduler.syncMeetings();
  }
}
