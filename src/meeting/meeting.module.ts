import { Module, OnModuleInit } from '@nestjs/common';
import { MeetingService } from './meeting.service';
import { MeetingController } from './meeting.controller';
import { RolesGuard } from '../auth/roles.guard';

@Module({
  controllers: [MeetingController],
  providers: [MeetingService, RolesGuard],
  exports: [MeetingService],
})
export class MeetingModule implements OnModuleInit {
  constructor(private readonly meetingService: MeetingService) {}

  async onModuleInit() {
    await this.meetingService.syncAttendanceWindows();
  }
}
