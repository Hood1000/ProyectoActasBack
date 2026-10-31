import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Request, Res, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AttendanceReportService } from './attendance-report.service';
import { AttendanceMonthlyReportDto, AttendanceReportQueryDto, IssueWarningDto } from './dto/attendance-report.dto';

@Controller('meetings')
@UseGuards(JwtAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class AttendanceReportController {
  constructor(private readonly reports: AttendanceReportService) {}

  @Get('attendance/history')
  @Roles('ADMIN', 'SECRETARIO')
  summary(@Query() query: AttendanceReportQueryDto) {
    return this.reports.summary(query);
  }

  @Get('attendance/history/:teacherId')
  @Roles('ADMIN', 'SECRETARIO')
  history(@Param('teacherId', ParseUUIDPipe) teacherId: string, @Query() query: AttendanceReportQueryDto) {
    return this.reports.history(teacherId, query);
  }

  @Get('attendance/report/pdf')
  @Roles('ADMIN', 'SECRETARIO')
  async monthlyReportPdf(@Query() query: AttendanceMonthlyReportDto, @Res() res: ExpressResponse) {
    const pdf = await this.reports.monthlyReportPdf(query.year, query.month);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="Asistencia-docentes-${query.year}-${String(query.month).padStart(2, '0')}.pdf"`,
      'Content-Length': String(pdf.length),
    });
    res.end(pdf);
  }

  @Get('absence-cases')
  @Roles('ADMIN', 'SECRETARIO')
  cases(@Query() query: AttendanceReportQueryDto) {
    return this.reports.cases(query);
  }

  @Post('absence-cases/:teacherId/warning')
  @Roles('SECRETARIO')
  issue(@Param('teacherId', ParseUUIDPipe) teacherId: string, @Request() req: { user: { id: string } }, @Body() dto: IssueWarningDto) {
    return this.reports.issue(teacherId, req.user.id, dto);
  }

  @Get('warnings')
  @Roles('ADMIN', 'SECRETARIO', 'DOCENTE')
  warnings(@Query() query: AttendanceReportQueryDto, @Request() req: { user: { id: string; role: string } }) {
    return this.reports.warnings(query, req.user);
  }

  @Get('warnings/:warningId')
  @Roles('ADMIN', 'SECRETARIO', 'DOCENTE')
  warning(@Param('warningId', ParseUUIDPipe) warningId: string, @Request() req: { user: { id: string; role: string } }) {
    return this.reports.warning(warningId, req.user);
  }
}