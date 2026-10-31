import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, Request, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { randomUUID } from 'crypto';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { MeetingService } from './meeting.service';
import { MeetingChatGateway } from './meeting-chat.gateway';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CancelMeetingDto } from './dto/cancel-meeting.dto';
import { CreateMeetingDto } from './dto/create-meeting.dto';
import { UpdateMeetingLogisticsDto } from './dto/update-meeting-logistics.dto';
import { SetInviteesDto } from './dto/set-invitees.dto';
import { MarkAttendanceDto } from './dto/mark-attendance.dto';
import { ProposeAgendaPointDto } from './dto/propose-agenda-point.dto';
import { ReviewAgendaPointDto } from './dto/review-agenda-point.dto';
import { AnnualCloseDto } from './dto/annual-close.dto';
import { CreateChatMessageDto } from './dto/create-chat-message.dto';
import { CreatePollDto } from './dto/create-poll.dto';
import { ReviewAbsenceAlertDto } from './dto/review-absence-alert.dto';
import { VotePollDto } from './dto/vote-poll.dto';
import { StorageService } from '../storage/storage.service';
import { detectFileSignature } from '../storage/file-signature';
import { MeetingAttendancePrivacyInterceptor } from './meeting-attendance.interceptor';

const MAX_UPLOAD_BYTES = Number(process.env.UPLOAD_MAX_BYTES || 15 * 1024 * 1024);
const ALLOWED_EVIDENCE_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
  'image/webp',
];
const EVIDENCE_FORMAT_ERROR = 'Solo se permiten archivos PDF, Word o imágenes (JPG, PNG, WebP) de hasta 15 MB';

@ApiTags('meetings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(MeetingAttendancePrivacyInterceptor)
@Controller('meetings')
export class MeetingController {
  constructor(
    private readonly meetingService: MeetingService,
    private readonly meetingChatGateway: MeetingChatGateway,
    private readonly storageService: StorageService,
  ) {}

  @Roles('ADMIN', 'SECRETARIO')
  @Post()
  create(@Request() req: { user: { id: string } }, @Body() dto: CreateMeetingDto) {
    return this.meetingService.create(req.user.id, dto);
  }

  @Get()
  findAll() {
    return this.meetingService.findAll();
  }

  @Roles('ADMIN', 'DOCENTE', 'SECRETARIO')
  @Get('agenda/available')
  getAvailableAgenda(
    @Request() req: { user: { id: string; role: string } },
    @Query('meetingId') meetingId?: string,
  ) {
    return this.meetingService.findAvailableAgendaForUser(req.user.id, req.user.role, meetingId);
  }

  @Roles('ADMIN')
  @Get('annual-archives')
  listAnnualArchives() {
    return this.meetingService.listAnnualArchives();
  }

  @Roles('ADMIN')
  @Get('annual-archives/:year/data')
  getAnnualArchiveData(@Param('year') year: string) {
    return this.meetingService.getAnnualArchiveData(Number(year));
  }

  @Roles('ADMIN')
  @Get('annual-archives/:year/pdf')
  async downloadAnnualReportPdf(@Param('year') year: string, @Res() res: ExpressResponse) {
    const pdf = await this.meetingService.generateAnnualReportPdf(Number(year));
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="Cierre-anual-${year}.pdf"`,
      'Content-Length': String(pdf.length),
    });
    res.end(pdf);
  }

  @Roles('ADMIN')
  @Post('annual-close')
  closeAnnualYear(@Request() req: { user: { id: string } }, @Body() dto: AnnualCloseDto) {
    return this.meetingService.closeAnnualYear(dto.year, req.user.id);
  }

  @Roles('ADMIN', 'SECRETARIO')
  @Get('absence-alerts')
  listAbsenceAlerts() {
    return this.meetingService.listAbsenceAlerts();
  }

  @Roles('ADMIN', 'DOCENTE', 'SECRETARIO')
  @Get('notifications')
  listMyNotifications(@Request() req: { user: { id: string } }) {
    return this.meetingService.listMyNotifications(req.user.id);
  }

  @Roles('ADMIN', 'DOCENTE', 'SECRETARIO')
  @Post('notifications/read-all')
  markAllNotificationsAsRead(@Request() req: { user: { id: string } }) {
    return this.meetingService.markAllNotificationsAsRead(req.user.id);
  }

  @Roles('ADMIN', 'DOCENTE', 'SECRETARIO')
  @Post('notifications/:recipientId/read')
  markNotificationAsRead(@Request() req: { user: { id: string } }, @Param('recipientId') recipientId: string) {
    return this.meetingService.markNotificationAsRead(recipientId, req.user.id);
  }

  @Roles('ADMIN', 'DOCENTE', 'SECRETARIO')
  @Delete('notifications/:recipientId')
  dismissNotification(@Request() req: { user: { id: string } }, @Param('recipientId') recipientId: string) {
    return this.meetingService.dismissNotification(recipientId, req.user.id);
  }

  @Roles('ADMIN', 'SECRETARIO')
  @Patch('absence-alerts/:alertId/review')
  reviewAbsenceAlert(
    @Request() req: { user: { id: string } },
    @Param('alertId') alertId: string,
    @Body() dto: ReviewAbsenceAlertDto,
  ) {
    return this.meetingService.reviewAbsenceAlert(alertId, req.user.id, dto);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const meeting = await this.meetingService.findOne(id);
    if (!meeting) {
      throw new NotFoundException('Reunion no encontrada');
    }
    return meeting;
  }

  @Roles('ADMIN', 'SECRETARIO')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateMeetingLogisticsDto) {
    return this.meetingService.updateLogistics(id, dto);
  }

  @Roles('ADMIN', 'SECRETARIO')
  @Post(':id/cancel')
  async cancel(
    @Request() req: { user: { id: string } },
    @Param('id') id: string,
    @Body() dto: CancelMeetingDto,
  ) {
    const meeting = await this.meetingService.cancelMeeting(id, req.user.id, dto);
    this.meetingChatGateway.emitMeetingStatus(meeting);
    return meeting;
  }

  @Roles('ADMIN', 'SECRETARIO')
  @Post(':id/voting/start')
  async startVoting(@Request() req: { user: { id: string } }, @Param('id') id: string) {
    const meeting = await this.meetingService.startVoting(id, req.user.id);
    this.meetingChatGateway.emitMeetingStatus(meeting);
    return meeting;
  }

  @Roles('ADMIN', 'SECRETARIO')
  @Patch(':id/invitees')
  setInvitees(@Param('id') id: string, @Body() dto: SetInviteesDto) {
    return this.meetingService.setInvitees(id, dto);
  }

  @Roles('ADMIN', 'SECRETARIO')
  @Patch(':id/attendance/:userId')
  markAttendance(@Param('id') id: string, @Param('userId') userId: string, @Body() dto: MarkAttendanceDto) {
    return this.meetingService.markAttendance(id, userId, dto);
  }

  @Roles('ADMIN', 'DOCENTE', 'SECRETARIO')
  @Post(':id/attendance/confirm')
  confirmAttendance(@Request() req: { user: { id: string } }, @Param('id') id: string) {
    return this.meetingService.confirmAttendanceForUser(id, req.user.id);
  }

  @Roles('ADMIN', 'DOCENTE', 'SECRETARIO')
  @Get(':id/chat')
  listMeetingChatMessages(
    @Request() req: { user: { id: string; role: string } },
    @Param('id') id: string,
    @Query('after') after?: string,
  ) {
    return this.meetingService.listMeetingChatMessages(id, req.user.id, req.user.role, after);
  }

  @Roles('ADMIN', 'DOCENTE', 'SECRETARIO')
  @Post(':id/chat')
  async postMeetingChatMessage(
    @Request() req: { user: { id: string; role: string } },
    @Param('id') id: string,
    @Body() dto: CreateChatMessageDto,
  ) {
    const created = await this.meetingService.postMeetingChatMessage(id, req.user.id, req.user.role, dto);
    this.meetingChatGateway.emitChatMessage(id, created);
    return created;
  }

  @Roles('ADMIN', 'DOCENTE', 'SECRETARIO')
  @Get(':id/polls')
  listMeetingPolls(@Request() req: { user: { id: string; role: string } }, @Param('id') id: string) {
    return this.meetingService.listMeetingPolls(id, req.user.id, req.user.role);
  }

  @Roles('ADMIN', 'SECRETARIO')
  @Post(':id/polls')
  async createMeetingPoll(
    @Request() req: { user: { id: string; role: string } },
    @Param('id') id: string,
    @Body() dto: CreatePollDto,
  ) {
    const poll = await this.meetingService.createMeetingPoll(id, req.user.id, req.user.role, dto);
    this.meetingChatGateway.emitPollUpdate(id, poll);
    return poll;
  }

  @Roles('ADMIN', 'DOCENTE', 'SECRETARIO')
  @Post(':id/polls/:pollId/vote')
  async voteMeetingPoll(
    @Request() req: { user: { id: string; role: string } },
    @Param('id') id: string,
    @Param('pollId') pollId: string,
    @Body() dto: VotePollDto,
  ) {
    const poll = await this.meetingService.voteMeetingPoll(id, pollId, req.user.id, req.user.role, dto);
    this.meetingChatGateway.emitPollUpdate(id, poll);
    return poll;
  }

  @Roles('ADMIN', 'SECRETARIO')
  @Post(':id/polls/:pollId/close')
  async closeMeetingPoll(
    @Request() req: { user: { role: string } },
    @Param('id') id: string,
    @Param('pollId') pollId: string,
  ) {
    const poll = await this.meetingService.closeMeetingPoll(id, pollId, req.user.role);
    this.meetingChatGateway.emitPollUpdate(id, poll);
    return poll;
  }

  @Roles('ADMIN', 'SECRETARIO')
  @Post(':id/attendance/finalize')
  finalizeAttendance(@Param('id') id: string) {
    return this.meetingService.finalizeAttendance(id);
  }

  @Roles('ADMIN', 'DOCENTE', 'SECRETARIO')
  @Post(':id/proposals')
  proposeAgendaPoint(
    @Request() req: { user: { id: string } },
    @Param('id') id: string,
    @Body() dto: ProposeAgendaPointDto,
  ) {
    return this.meetingService.proposeAgendaPoint(id, req.user.id, dto);
  }

  @Roles('ADMIN', 'SECRETARIO')
  @Patch(':id/proposals/:proposalId/review')
  reviewAgendaPoint(
    @Request() req: { user: { id: string } },
    @Param('id') id: string,
    @Param('proposalId') proposalId: string,
    @Body() dto: ReviewAgendaPointDto,
  ) {
    return this.meetingService.reviewAgendaPoint(id, proposalId, req.user.id, dto);
  }

  @Roles('ADMIN', 'SECRETARIO')
  @Post(':id/agenda/consolidate')
  consolidateAgenda(@Param('id') id: string) {
    return this.meetingService.consolidateAgenda(id);
  }

  @Roles('ADMIN', 'SECRETARIO')
  @Post(':id/close')
  async closeMeeting(@Param('id') id: string) {
    const { meeting, closedPolls } = await this.meetingService.closeMeeting(id);
    closedPolls.forEach((poll) => this.meetingChatGateway.emitPollUpdate(id, poll));
    this.meetingChatGateway.emitMeetingStatus(meeting);
    return meeting;
  }

  @Roles('ADMIN', 'DOCENTE', 'SECRETARIO')
  @Get(':id/evidence/url')
  async getEvidenceUrl(
    @Request() req: ExpressRequest & { user: { id: string; role: string } },
    @Param('id') id: string,
  ) {
    const reference = await this.meetingService.getEvidenceReference(id, req.user.id, req.user.role);
    const baseUrl = process.env.PUBLIC_API_URL?.replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
    return this.storageService.getSignedReadUrl(reference, baseUrl);
  }

  @Roles('ADMIN', 'SECRETARIO')
  @Post(':id/evidence/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      // En memoria: el archivo se valida y se envia al almacenamiento sin tocar el disco.
      storage: memoryStorage(),
      fileFilter: (_req, file, cb) => {
        if (ALLOWED_EVIDENCE_MIME_TYPES.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new BadRequestException(EVIDENCE_FORMAT_ERROR), false);
        }
      },
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    }),
  )
  async uploadEvidenceFile(@Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException(EVIDENCE_FORMAT_ERROR);
    }

    const detected = detectFileSignature(file.buffer);
    if (!detected) {
      throw new BadRequestException('El contenido del archivo no corresponde a un PDF, Word o imagen valida');
    }

    // Se valida antes de subir para no dejar archivos huerfanos en el bucket.
    await this.meetingService.ensureEvidenceUploadAllowed(id);

    const key = `meetings/${id}/evidence/${randomUUID()}${detected.extension}`;
    const reference = await this.storageService.upload(file.buffer, key, detected.contentType);

    try {
      const { meeting, previousReference } = await this.meetingService.setEvidenceReference(id, reference);
      await this.storageService.deleteQuietly(previousReference);
      return meeting;
    } catch (error) {
      // La reunion cambio de estado mientras se subia el archivo.
      await this.storageService.deleteQuietly(reference);
      throw error;
    }
  }

  @Roles('ADMIN', 'SECRETARIO')
  @Post('attendance/sync')
  syncAttendanceWindows() {
    return this.meetingService.syncAttendanceWindows();
  }

  @Roles('ADMIN')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.meetingService.remove(id);
  }
}
