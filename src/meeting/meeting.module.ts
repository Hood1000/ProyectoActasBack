import { Module, OnModuleInit } from '@nestjs/common';
import { MeetingService } from './meeting.service';
import { MeetingController } from './meeting.controller';
import { MeetingChatGateway } from './meeting-chat.gateway';
import { MeetingScheduler } from './meeting.scheduler';
import { RolesGuard } from '../auth/roles.guard';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { SessionModule } from '../auth/session.module';

@Module({
  imports: [AuthModule, MailModule, SessionModule],
  controllers: [MeetingController],
  providers: [MeetingService, MeetingChatGateway, MeetingScheduler, RolesGuard],
  exports: [MeetingService],
})
export class MeetingModule implements OnModuleInit {
  constructor(private readonly meetingScheduler: MeetingScheduler) {}

  async onModuleInit() {
    await this.meetingScheduler.syncMeetings();
  }
}
