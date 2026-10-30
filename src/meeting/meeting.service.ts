import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AbsenceAlertReviewStatus,
  AttendanceStatus,
  AgendaStatus,
  MeetingCategory,
  NotificationType,
  PollOption,
  PollStatus,
  Prisma,
  Role,
  Status,
} from '../../generated/prisma';
import prisma from '../prismaClient';
import * as fs from 'fs';
import { createHash } from 'crypto';
import { gunzipSync, gzipSync } from 'zlib';
import { join } from 'path';
import nodemailer from 'nodemailer';
import { CancelMeetingDto } from './dto/cancel-meeting.dto';
import { CreateMeetingDto } from './dto/create-meeting.dto';
import { MarkAttendanceDto } from './dto/mark-attendance.dto';
import { ProposeAgendaPointDto } from './dto/propose-agenda-point.dto';
import { ReviewAgendaPointDto } from './dto/review-agenda-point.dto';
import { SetInviteesDto } from './dto/set-invitees.dto';
import { UpdateMeetingLogisticsDto } from './dto/update-meeting-logistics.dto';
import { CreateChatMessageDto } from './dto/create-chat-message.dto';
import { CreatePollDto } from './dto/create-poll.dto';
import { ReviewAbsenceAlertDto } from './dto/review-absence-alert.dto';
import { VotePollDto } from './dto/vote-poll.dto';
import puppeteer from 'puppeteer';

type AnnualArchiveManifest = {
  backupFileName?: string;
  backupUrl?: string;
  checksumSha256: string;
  closedAt: string;
  closedByUserId: string;
  fileName: string;
  fileUrl: string;
  meetingsCount: number;
  reportFileName?: string;
  reportUrl?: string;
  year: number;
};

type AnnualArchivePayload = {
  closedAt: string;
  closedByUserId: string;
  meetings: Array<{
    agendaConsolidated: boolean;
    agendaPoints: Array<{
      createdAt: Date;
      description: string;
      id: string;
      isBasePoint: boolean;
      proposer: { id: string; name: string; role: string } | null;
      reviewComment: string | null;
      status: string;
      title: string;
      updatedAt: Date;
    }>;
    attendance: Array<{
      excuse: string | null;
      markedAt: Date | null;
      status: string;
      user: { email: string; id: string; name: string; role: string };
    }>;
    attendanceFinalized: boolean;
    cancellationReason: string | null;
    category: string;
    closedAt: Date | null;
    date: Date;
    description: string | null;
    evidenceSignaturesUrl: string | null;
    finalSummary: string | null;
    hasQuorum: boolean;
    id: string;
    isClosed: boolean;
    location: string;
    modality: string;
    organizer: { email: string; id: string; name: string; role: string };
    quorumMinimo: number;
    status: string;
    title: string;
  }>;
  stats: {
    approvedPoints: number;
    meetingsClosed: number;
    meetingsTotal: number;
    presentMarks: number;
  };
  year: number;
};

@Injectable()
export class MeetingService {
  private static readonly MAX_POINTS_PER_USER = 2;
  private static readonly AUTO_CANCEL_REASON =
    'La reunión no se realizó en la fecha programada y fue cancelada automáticamente por el sistema.';
  private static readonly ABSENCE_ALERT_THRESHOLD = 3;
  private static readonly AGENDA_PROPOSAL_HOURS_BEFORE_MEETING = 24;
  private static readonly TZ = process.env.APP_TIMEZONE || 'America/Caracas';
  private static readonly WORK_HOURS = {
    start: Number(process.env.WORK_HOURS_START || 7),
    end: Number(process.env.WORK_HOURS_END || 18),
  };
  private static readonly PREVIOUS_MINUTE_POINT = {
    description: 'Lectura, revisión y consideración del acta de la reunión anterior como primer punto obligatorio del orden del día.',
    title: 'Lectura del acta anterior',
  };
  private readonly annualArchiveDir = join(process.cwd(), 'uploads', 'annual-archives');
  private readonly annualArchiveIndexFile = join(this.annualArchiveDir, 'index.json');

  private formatEmailDate(value: Date | string | null | undefined): string {
    if (!value) return 'Sin fecha';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return 'Sin fecha';
    return parsed.toLocaleString('es-VE', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: MeetingService.TZ,
    });
  }

  private async resolveMeetingEmailRecipients(meetingId: string, organizerId?: string | null) {
    const directRecipients = await prisma.attendance.findMany({
      where: { meetingId },
      select: {
        user: {
          select: {
            email: true,
            id: true,
            isActive: true,
            name: true,
          },
        },
      },
    });

    let recipients = directRecipients
      .map((entry) => entry.user)
      .filter((user) => user?.isActive && user.email && user.id !== organizerId);

    if (recipients.length === 0) {
      recipients = await prisma.user.findMany({
        where: {
          id: organizerId ? { not: organizerId } : undefined,
          isActive: true,
          role: { in: [Role.DOCENTE, Role.SECRETARIO] },
        },
        select: { email: true, id: true, isActive: true, name: true },
      });
    }

    const unique = new Map<string, { email: string; id: string; name: string }>();
    recipients.forEach((user) => {
      if (user?.email && !unique.has(user.email)) {
        unique.set(user.email, { email: user.email, id: user.id, name: user.name });
      }
    });

    return [...unique.values()];
  }

  private async sendMeetingEmailNotification(
    meeting: {
      date: Date;
      description?: string | null;
      id: string;
      location: string;
      modality: string;
      organizer?: { name: string } | null;
      organizerId?: string;
      title: string;
    },
    type: 'created' | 'updated',
  ) {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT || 587);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const from = process.env.SMTP_FROM || user;

    if (!host || !user || !pass || !from) {
      return;
    }

    const recipients = await this.resolveMeetingEmailRecipients(meeting.id, meeting.organizerId);
    if (recipients.length === 0) {
      return;
    }

    const transporter = nodemailer.createTransport({
      auth: { user, pass },
      host,
      port,
      secure: port === 465,
    });

    const subject =
      type === 'created'
        ? `Nueva reunión programada: ${meeting.title}`
        : `Actualización de reunión: ${meeting.title}`;

    const heading = type === 'created' ? 'Nueva reunión disponible' : 'Actualización de reunión';
    const accent = type === 'created' ? '#1d4ed8' : '#0f766e';

    const html = `
      <div style="background:#f5f8ff;padding:24px;font-family:Arial,sans-serif;color:#172033;">
        <div style="max-width:720px;margin:0 auto;background:#ffffff;border:1px solid #dbe4f4;border-radius:18px;overflow:hidden;">
          <div style="padding:24px;background:linear-gradient(135deg, ${accent} 0%, #0f172a 100%);color:#ffffff;">
            <h1 style="margin:0;font-size:26px;">${heading}</h1>
            <p style="margin:8px 0 0;font-size:14px;opacity:.92;">Sistema institucional de reuniones UPT JFR</p>
          </div>
          <div style="padding:24px;">
            <h2 style="margin:0 0 12px;font-size:22px;">${meeting.title}</h2>
            <p style="margin:0 0 18px;line-height:1.6;color:#475569;">${meeting.description || 'Se registró una reunión en el sistema y ya puedes revisarla desde tu panel.'}</p>
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
              <tr><td style="padding:10px;border:1px solid #e2e8f0;"><strong>Fecha</strong></td><td style="padding:10px;border:1px solid #e2e8f0;">${this.formatEmailDate(meeting.date)}</td></tr>
              <tr><td style="padding:10px;border:1px solid #e2e8f0;"><strong>Lugar</strong></td><td style="padding:10px;border:1px solid #e2e8f0;">${meeting.location}</td></tr>
              <tr><td style="padding:10px;border:1px solid #e2e8f0;"><strong>Modalidad</strong></td><td style="padding:10px;border:1px solid #e2e8f0;">${meeting.modality}</td></tr>
              <tr><td style="padding:10px;border:1px solid #e2e8f0;"><strong>Organiza</strong></td><td style="padding:10px;border:1px solid #e2e8f0;">${meeting.organizer?.name || 'Coordinación'}</td></tr>
            </table>
            <p style="margin:18px 0 0;line-height:1.6;color:#334155;">Recuerda ingresar al sistema para revisar la convocatoria, los puntos asociados y confirmar asistencia cuando la ventana se abra.</p>
          </div>
        </div>
      </div>`;

    try {
      await transporter.sendMail({
        from,
        html,
        subject,
        to: recipients.map((recipient) => recipient.email).join(','),
      });
    } catch (error) {
      console.error('No se pudo enviar el correo de reunión:', error);
    }
  }

  private async sendAbsenceAlertEmailNotification(payload: {
    absencesCount: number;
    academicYear: number;
    meetingDate: Date;
    meetingTitle: string;
    teacherName: string;
  }) {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT || 587);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const from = process.env.SMTP_FROM || user;

    if (!host || !user || !pass || !from) {
      return;
    }

    const secretaries = await prisma.user.findMany({
      where: {
        isActive: true,
        role: Role.SECRETARIO,
      },
      select: {
        email: true,
      },
    });

    const recipients = secretaries.map((secretary) => secretary.email).filter(Boolean);
    if (recipients.length === 0) {
      return;
    }

    const transporter = nodemailer.createTransport({
      auth: { user, pass },
      host,
      port,
      secure: port === 465,
    });

    const subject = `Alerta de inasistencias: ${payload.teacherName}`;
    const html = `
      <div style="background:#f5f8ff;padding:24px;font-family:Arial,sans-serif;color:#172033;">
        <div style="max-width:720px;margin:0 auto;background:#ffffff;border:1px solid #dbe4f4;border-radius:18px;overflow:hidden;">
          <div style="padding:24px;background:linear-gradient(135deg, #9f1239 0%, #0f172a 100%);color:#ffffff;">
            <h1 style="margin:0;font-size:24px;">Alerta automática de inasistencia</h1>
            <p style="margin:8px 0 0;font-size:14px;opacity:.92;">Control institucional de asistencia docente</p>
          </div>
          <div style="padding:24px;">
            <p style="margin:0 0 12px;line-height:1.6;">El docente <strong>${payload.teacherName}</strong> acumula <strong>${payload.absencesCount} inasistencias injustificadas</strong> en el año ${payload.academicYear}.</p>
            <p style="margin:0 0 12px;line-height:1.6;">Última reunión considerada: <strong>${payload.meetingTitle}</strong> (${this.formatEmailDate(payload.meetingDate)}).</p>
            <p style="margin:0;line-height:1.6;color:#334155;">La amonestación o gestión disciplinaria se realiza por vía externa según protocolo institucional. Si existe justificativo médico o causa mayor, puede registrarse por secretaría.</p>
          </div>
        </div>
      </div>`;

    try {
      await transporter.sendMail({
        from,
        html,
        subject,
        to: recipients.join(','),
      });
    } catch (error) {
      console.error('No se pudo enviar el correo de alerta por inasistencia:', error);
    }
  }

  private async createSystemNotificationForUsers(payload: {
    absenceAlertId?: string;
    actionHref?: string;
    message: string;
    title: string;
    type: NotificationType;
    userIds: string[];
  }) {
    const uniqueUserIds = [...new Set(payload.userIds.filter(Boolean))];
    if (uniqueUserIds.length === 0) {
      return null;
    }

    return prisma.systemNotification.create({
      data: {
        absenceAlertId: payload.absenceAlertId,
        actionHref: payload.actionHref,
        message: payload.message,
        title: payload.title,
        type: payload.type,
        recipients: {
          create: uniqueUserIds.map((userId) => ({ userId })),
        },
      },
    });
  }

  private async triggerAbsenceThresholdAlerts(meetingId: string) {
    const meeting = await prisma.meeting.findUnique({
      where: { id: meetingId },
      select: {
        attendanceFinalized: true,
        date: true,
        id: true,
        status: true,
        title: true,
        attendance: {
          where: {
            status: AttendanceStatus.AUSENTE,
          },
          select: {
            userId: true,
            user: {
              select: {
                id: true,
                name: true,
                role: true,
              },
            },
          },
        },
      },
    });

    if (!meeting || !meeting.attendanceFinalized || meeting.status === Status.CANCELADA) {
      return;
    }

    const academicYear = meeting.date.getFullYear();
    const from = new Date(Date.UTC(academicYear, 0, 1, 0, 0, 0, 0));
    const to = new Date(Date.UTC(academicYear + 1, 0, 1, 0, 0, 0, 0));

    const absentTeachers = meeting.attendance
      .filter((entry) => entry.user.role === Role.DOCENTE)
      .map((entry) => ({ id: entry.user.id, name: entry.user.name }));

    if (absentTeachers.length === 0) {
      return;
    }

    const uniqueTeachers = Array.from(
      new Map(absentTeachers.map((teacher) => [teacher.id, teacher])).values(),
    );
    const secretaries = await prisma.user.findMany({
      where: {
        isActive: true,
        role: Role.SECRETARIO,
      },
      select: { id: true },
    });
    const secretaryIds = secretaries.map((secretary) => secretary.id);

    for (const teacher of uniqueTeachers) {
      const absencesCount = await prisma.attendance.count({
        where: {
          meeting: {
            attendanceFinalized: true,
            date: {
              gte: from,
              lt: to,
            },
            status: {
              not: Status.CANCELADA,
            },
          },
          status: AttendanceStatus.AUSENTE,
          userId: teacher.id,
          OR: [{ excuse: null }, { excuse: '' }],
        },
      });

      if (absencesCount < MeetingService.ABSENCE_ALERT_THRESHOLD) {
        continue;
      }

      const alreadyAlerted = await prisma.absenceAlert.findUnique({
        where: {
          teacherId_academicYear_threshold: {
            teacherId: teacher.id,
            academicYear,
            threshold: MeetingService.ABSENCE_ALERT_THRESHOLD,
          },
        },
      });

      if (alreadyAlerted) {
        continue;
      }

      const summary = `Docente ${teacher.name} alcanzó ${absencesCount} inasistencias injustificadas en ${academicYear}.`;
      let createdAlert: { id: string };
      try {
        createdAlert = await prisma.absenceAlert.create({
          data: {
            teacherId: teacher.id,
            meetingId: meeting.id,
            academicYear,
            threshold: MeetingService.ABSENCE_ALERT_THRESHOLD,
            absencesCount,
            summary,
          },
        });
      } catch (error) {
        // Otra peticion concurrente ya creo la alerta: no es un error para quien marco asistencia.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          continue;
        }
        throw error;
      }

      await this.createSystemNotificationForUsers({
        absenceAlertId: createdAlert.id,
        actionHref: '/dashboard/sanctions',
        message: summary,
        title: 'Alerta de inasistencia docente',
        type: NotificationType.ABSENCE_ALERT,
        userIds: secretaryIds,
      });

      await this.sendAbsenceAlertEmailNotification({
        absencesCount,
        academicYear,
        meetingDate: meeting.date,
        meetingTitle: meeting.title,
        teacherName: teacher.name,
      });
    }
  }

  private readonly meetingInclude = {
    organizer: {
      select: { id: true, name: true, email: true, role: true },
    },
    cancelledBy: {
      select: { id: true, name: true, role: true },
    },
    attendance: {
      include: {
        user: {
          select: { id: true, name: true, email: true, role: true },
        },
      },
    },
    agendaPoints: {
      include: {
        proposer: {
          select: { id: true, name: true, email: true, role: true },
        },
      },
      orderBy: { createdAt: 'asc' as const },
    },
    minute: true,
    actionItems: true,
  };

  private readonly attendanceOpenMinutesBefore = 15;

  private quorumMinimum(meetingCategory: MeetingCategory): number {
    return meetingCategory === MeetingCategory.ASAMBLEA ? 1 : 2;
  }

  private quorumIndicator(hasQuorum: boolean): string {
    return hasQuorum ? '🟢 QUORUM ALCANZADO' : '🔴 SIN QUORUM';
  }

  private buildBaseAgendaPoints(
    baseAgendaPoints: Array<{ description: string; title: string }> = [],
  ) {
    const normalizedMandatoryTitle = MeetingService.PREVIOUS_MINUTE_POINT.title.trim().toLowerCase();
    const filteredPoints = baseAgendaPoints.filter(
      (point) => point.title.trim().toLowerCase() !== normalizedMandatoryTitle,
    );

    return [MeetingService.PREVIOUS_MINUTE_POINT, ...filteredPoints].map((point) => ({
      description: point.description,
      isBasePoint: true,
      status: AgendaStatus.APROBADO,
      title: point.title,
    }));
  }

  private mapMeetingView<
    T extends {
      hasQuorum: boolean;
      attendance: { status: AttendanceStatus }[];
      quorumMinimo: number;
      meetingCategory: MeetingCategory;
    },
  >(meeting: T) {
    const presentCount = meeting.attendance.filter((entry) => entry.status === AttendanceStatus.PRESENTE).length;
    const totalInvited = meeting.attendance.length;
    const quorumDescription =
      meeting.meetingCategory === MeetingCategory.ASAMBLEA
        ? 'Secretaria presente'
        : 'Secretaria + 1 participante presente';

    return {
      ...meeting,
      totalInvited,
      presentCount,
      quorumIndicator: this.quorumIndicator(meeting.hasQuorum),
      quorumFormula: quorumDescription,
    };
  }

  private previousMinuteFrom(
    previous: {
      id: string;
      title: string;
      date: Date;
      agendaPoints: { title: string; description: string; status: AgendaStatus; isBasePoint: boolean }[];
    } | null,
  ) {
    if (!previous) {
      return null;
    }

    // Puntos que quedaron sin resolver (PENDIENTE) en el acta anterior: se arrastran
    // para retomarlos, no el orden del día ya aprobado.
    const points = (previous.agendaPoints || [])
      .filter((point) => point.status === AgendaStatus.PENDIENTE)
      .map((point) => ({ title: point.title, description: point.description }));

    return {
      meetingId: previous.id,
      title: previous.title,
      date: previous.date,
      points,
    };
  }

  private findPreviousClosedMeeting<
    T extends { id: string; date: Date; meetingCategory: MeetingCategory; isClosed: boolean },
  >(meeting: T, allMeetings: T[]): T | null {
    return (
      allMeetings
        .filter(
          (candidate) =>
            candidate.id !== meeting.id &&
            candidate.meetingCategory === meeting.meetingCategory &&
            candidate.isClosed &&
            new Date(candidate.date).getTime() < new Date(meeting.date).getTime(),
        )
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0] || null
    );
  }

  private async getMeetingOrThrow(id: string) {
    const meeting = await prisma.meeting.findUnique({ where: { id } });
    if (!meeting) {
      throw new NotFoundException('Reunion no encontrada');
    }
    return meeting;
  }

  // Bloquea la fila de la reunion dentro de una transaccion. FOR UPDATE serializa los
  // cambios de estado (cerrar, cancelar, iniciar votacion); FOR SHARE deja que muchos
  // mensajes o votos convivan, pero espera a que termine un cierre en curso.
  private async lockMeeting(tx: Prisma.TransactionClient, id: string, mode: 'UPDATE' | 'SHARE' = 'UPDATE') {
    const lockClause = mode === 'UPDATE' ? Prisma.sql`FOR UPDATE` : Prisma.sql`FOR SHARE`;
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        status: Status;
        isClosed: boolean;
        votingOpen: boolean;
        hasQuorum: boolean;
        attendanceFinalized: boolean;
      }>
    >`SELECT "id", "status", "isClosed", "votingOpen", "hasQuorum", "attendanceFinalized"
      FROM "Meeting" WHERE "id" = ${id} ${lockClause}`;

    if (rows.length === 0) {
      throw new NotFoundException('Reunion no encontrada');
    }
    return rows[0];
  }

  private isMeetingReadOnly(meeting: { isClosed: boolean; status: Status }): boolean {
    return meeting.isClosed || meeting.status === Status.CANCELADA || meeting.status === Status.FINALIZADA;
  }

  private ensureMeetingEditable(isClosed: boolean): void {
    if (isClosed) {
      throw new ForbiddenException('La reunion esta cerrada y no admite ediciones');
    }
  }

  private ensureAcademicYearOpenByDate(date: Date): void {
    if (process.env.ANNUAL_CLOSE_ENFORCE_READ_ONLY === 'false') {
      return;
    }

    const year = date.getFullYear();
    const hasClosedYear = this.readAnnualArchiveIndex().some((entry) => entry.year === year);
    if (hasClosedYear) {
      throw new ForbiddenException(`El año lectivo ${year} está cerrado y solo permite lectura`);
    }
  }

  private hourInInstitutionalZone(date: Date): number {
    const parts = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      hour12: false,
      timeZone: MeetingService.TZ,
    }).formatToParts(date);
    const hourPart = parts.find((part) => part.type === 'hour')?.value ?? '0';
    const hour = Number(hourPart);
    return hour === 24 ? 0 : hour;
  }

  private ensureMeetingSchedule(date: Date): void {
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('La fecha de la reunión no es válida');
    }

    if (date.getTime() <= Date.now()) {
      throw new BadRequestException('La reunión debe programarse a una fecha y hora futura');
    }

    const { start, end } = MeetingService.WORK_HOURS;
    const hour = this.hourInInstitutionalZone(date);
    if (hour < start || hour >= end) {
      throw new BadRequestException(
        `La reunión debe programarse dentro del horario institucional (${start}:00 a ${end}:00)`,
      );
    }
  }

  private readAnnualArchiveIndex(): AnnualArchiveManifest[] {
    fs.mkdirSync(this.annualArchiveDir, { recursive: true });
    if (!fs.existsSync(this.annualArchiveIndexFile)) {
      return [];
    }

    try {
      const raw = fs.readFileSync(this.annualArchiveIndexFile, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private writeAnnualArchiveIndex(index: AnnualArchiveManifest[]): void {
    fs.mkdirSync(this.annualArchiveDir, { recursive: true });
    fs.writeFileSync(this.annualArchiveIndexFile, JSON.stringify(index, null, 2), 'utf-8');
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private formatReportDate(value: Date | string | null | undefined): string {
    if (!value) return 'No disponible';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return 'No disponible';
    return parsed.toLocaleString('es-VE', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: MeetingService.TZ,
    });
  }

  private buildAnnualReportHtml(payload: AnnualArchivePayload): string {
    const STATUS: Record<string, string> = { PROGRAMADA: 'Programada', EN_CURSO: 'En curso', FINALIZADA: 'Finalizada', CANCELADA: 'Cancelada' };
    const POINT: Record<string, string> = { PENDIENTE: 'Pendiente', APROBADO: 'Aprobado', RECHAZADO: 'Rechazado' };
    const ATT: Record<string, string> = { PENDIENTE: 'Pendiente', PRESENTE: 'Presente', AUSENTE: 'Ausente', JUSTIFICADA: 'Justificada' };
    const ROLE: Record<string, string> = { ADMIN: 'Administrador', DOCENTE: 'Docente', SECRETARIO: 'Secretario' };
    const CAT: Record<string, string> = { CONSEJO_CARRERA: 'Consejo Operativo (CICVSO)', CID_PEDAGOGICO: 'Consejo Pedagógico (CICVSP)', ASAMBLEA: 'Asambleas' };
    const MOD: Record<string, string> = { PRESENCIAL: 'Presencial', VIRTUAL: 'Virtual', HIBRIDA: 'Híbrida' };
    const label = (map: Record<string, string>, key: string) => map[key] || key;

    const summaryCards = [
      ['Reuniones registradas', String(payload.stats.meetingsTotal)],
      ['Reuniones cerradas', String(payload.stats.meetingsClosed)],
      ['Asistencias presentes', String(payload.stats.presentMarks)],
      ['Puntos aprobados', String(payload.stats.approvedPoints)],
    ]
      .map(
        ([label, value]) => `
          <div class="card">
            <span class="card-label">${this.escapeHtml(label)}</span>
            <strong class="card-value">${this.escapeHtml(value)}</strong>
          </div>`,
      )
      .join('');

    const meetingsHtml = payload.meetings
      .map((meeting, index) => {
        const attendanceRows = meeting.attendance.length
          ? meeting.attendance
              .map(
                (entry) => `
                  <tr>
                    <td>${this.escapeHtml(entry.user.name || 'Sin nombre')}</td>
                    <td>${this.escapeHtml(label(ROLE, entry.user.role) || '-')}</td>
                    <td>${this.escapeHtml(label(ATT, entry.status))}</td>
                    <td>${this.escapeHtml(this.formatReportDate(entry.markedAt))}</td>
                    <td>${this.escapeHtml(entry.excuse || '-')}</td>
                  </tr>`,
              )
              .join('')
          : '<tr><td colspan="5">Sin asistencias registradas.</td></tr>';

        const agendaRows = meeting.agendaPoints.length
          ? meeting.agendaPoints
              .map(
                (point) => `
                  <tr>
                    <td>${this.escapeHtml(point.title)}</td>
                    <td><span class="badge badge--${point.status.toLowerCase()}">${this.escapeHtml(label(POINT, point.status))}</span></td>
                    <td>${this.escapeHtml(point.proposer?.name || 'Coordinación')}</td>
                    <td>${this.escapeHtml(point.isBasePoint ? 'Sí' : 'No')}</td>
                    <td>${this.escapeHtml(point.status === 'RECHAZADO' ? point.reviewComment || 'No registrado' : '-')}</td>
                  </tr>`,
              )
              .join('')
          : '<tr><td colspan="5">Sin puntos de agenda registrados.</td></tr>';

        return `
          <section class="meeting">
            <div class="meeting-head">
              <div>
                <h2>${index + 1}. ${this.escapeHtml(meeting.title)}</h2>
                <p>${this.escapeHtml(meeting.description || 'Sin descripción registrada.')}</p>
              </div>
              <span class="status status--${meeting.status.toLowerCase()}">${this.escapeHtml(label(STATUS, meeting.status))}</span>
            </div>

            <div class="meta-grid">
              <div><strong>Fecha:</strong> ${this.escapeHtml(this.formatReportDate(meeting.date))}</div>
              <div><strong>Categoría:</strong> ${this.escapeHtml(label(CAT, meeting.category))}</div>
              <div><strong>Modalidad:</strong> ${this.escapeHtml(label(MOD, meeting.modality))}</div>
              <div><strong>Lugar:</strong> ${this.escapeHtml(meeting.location || 'No registrado')}</div>
              <div><strong>Organiza:</strong> ${this.escapeHtml(meeting.organizer.name)}</div>
              <div><strong>Quórum:</strong> ${this.escapeHtml(meeting.hasQuorum ? 'Alcanzado' : 'No alcanzado')}</div>
              <div><strong>Puntos aprobados:</strong> ${meeting.agendaPoints.filter((p) => p.status === 'APROBADO').length}</div>
            </div>
            ${meeting.status === 'CANCELADA' ? `<div class="notice"><strong>Motivo de cancelación:</strong> ${this.escapeHtml(meeting.cancellationReason || 'No se registró un motivo.')}</div>` : ''}

            <div class="block">
              <h3>Asistencia</h3>
              <table>
                <thead>
                  <tr>
                    <th>Participante</th>
                    <th>Rol</th>
                    <th>Estado</th>
                    <th>Marcado</th>
                    <th>Observación</th>
                  </tr>
                </thead>
                <tbody>${attendanceRows}</tbody>
              </table>
            </div>

            <div class="block">
              <h3>Agenda</h3>
              <table>
                <thead>
                  <tr>
                    <th>Punto</th>
                    <th>Estado</th>
                    <th>Propuesto por</th>
                    <th>Base</th>
                    <th>Motivo de rechazo</th>
                  </tr>
                </thead>
                <tbody>${agendaRows}</tbody>
              </table>
            </div>

            <div class="block compact">
              <p><strong>Resumen final:</strong> ${this.escapeHtml(meeting.finalSummary || 'No disponible')}</p>
              <p><strong>Evidencia:</strong> ${this.escapeHtml(meeting.evidenceSignaturesUrl || 'No registrada')}</p>
            </div>
          </section>`;
      })
      .join('');

    return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Cierre anual ${payload.year}</title>
    <style>
      body { font-family: Georgia, "Times New Roman", serif; margin: 0; color: #172033; background: #f4f6fb; }
      .page { max-width: 1100px; margin: 0 auto; padding: 32px; }
      .hero { background: #fff; border: 1px solid #d8dfef; border-radius: 18px; padding: 28px; box-shadow: 0 20px 40px rgba(20, 34, 66, 0.08); }
      h1 { margin: 0 0 8px; font-size: 32px; }
      .hero p { margin: 6px 0; color: #44506b; }
      .cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 22px; }
      .card { background: linear-gradient(180deg, #f8fbff 0%, #eef3ff 100%); border: 1px solid #dbe4fa; border-radius: 14px; padding: 16px; }
      .card-label { display: block; font-size: 12px; text-transform: uppercase; color: #61708d; margin-bottom: 8px; }
      .card-value { font-size: 28px; color: #15213a; }
      .meeting { background: #fff; border: 1px solid #d8dfef; border-radius: 18px; padding: 24px; margin-top: 22px; }
      .meeting-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
      .meeting-head h2 { margin: 0 0 8px; font-size: 24px; }
      .meeting-head p { margin: 0; color: #44506b; }
      .status { background: #e7eefc; color: #1f3d7a; padding: 8px 12px; border-radius: 999px; font-size: 12px; font-weight: 700; }
      .meta-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 18px; margin: 18px 0; color: #22304f; }
      .block { margin-top: 18px; }
      .block h3 { margin: 0 0 10px; font-size: 18px; }
      .compact p { margin: 8px 0; }
      table { width: 100%; border-collapse: collapse; font-size: 14px; }
      th, td { border: 1px solid #dbe4fa; padding: 10px; text-align: left; vertical-align: top; }
      th { background: #f3f7ff; color: #233253; }
      .status--programada { background: #eff6ff; color: #1d4ed8; }
      .status--en_curso { background: #ecfdf5; color: #065f46; }
      .status--finalizada { background: #f1f5f9; color: #334155; }
      .status--cancelada { background: #fef2f2; color: #991b1b; }
      .badge { display: inline-block; border-radius: 999px; padding: 2px 8px; font-size: 12px; font-weight: 700; }
      .badge--aprobado { background: #ecfdf5; color: #065f46; }
      .badge--rechazado { background: #fef2f2; color: #991b1b; }
      .badge--pendiente { background: #fffbeb; color: #92400e; }
      .notice { background: #fef2f2; border: 1px solid #fecaca; border-radius: 12px; color: #991b1b; padding: 12px 14px; margin: 6px 0 2px; }
      .print-btn { position: fixed; top: 16px; right: 16px; z-index: 10; background: #1f3d7a; color: #fff; border: none; border-radius: 10px; padding: 12px 18px; font-size: 14px; font-weight: 700; cursor: pointer; box-shadow: 0 10px 24px rgba(20, 34, 66, 0.25); }
      @media print { body { background: #fff; } .page { padding: 0; } .hero, .meeting { box-shadow: none; } .print-btn { display: none; } }
      @media (max-width: 900px) { .cards, .meta-grid { grid-template-columns: 1fr; } .meeting-head { flex-direction: column; } }
    </style>
  </head>
  <body>
    <button class="print-btn" onclick="window.print()" type="button">Guardar como PDF</button>
    <main class="page">
      <section class="hero">
        <h1>Cierre anual ${this.escapeHtml(String(payload.year))}</h1>
        <p><strong>Fecha de cierre:</strong> ${this.escapeHtml(this.formatReportDate(payload.closedAt))}</p>
        <p><strong>Responsable:</strong> ${this.escapeHtml(payload.closedByUserId)}</p>
        <p>Documento consolidado del año con reuniones, asistencia, agenda, estado de cierre y evidencias registradas.</p>
        <div class="cards">${summaryCards}</div>
      </section>
      ${meetingsHtml || '<section class="meeting"><h2>Sin reuniones</h2><p>No se registraron reuniones en el período seleccionado.</p></section>'}
    </main>
    <script>
      if (location.search.indexOf('print') !== -1) {
        window.addEventListener('load', function () { window.print(); });
      }
    </script>
  </body>
</html>`;
  }

  private ensureReadableAnnualReport(manifest: AnnualArchiveManifest): AnnualArchiveManifest {
    const backupFileName = manifest.backupFileName || manifest.fileName;
    const backupUrl = manifest.backupUrl || manifest.fileUrl;
    const backupPath = join(this.annualArchiveDir, backupFileName);

    // Sin un backup .json.gz valido no se puede regenerar: se devuelve el manifiesto tal cual.
    if (!backupFileName.endsWith('.json.gz') || !fs.existsSync(backupPath)) {
      return manifest;
    }

    // Siempre se regenera el HTML desde el backup para que use la plantilla actual
    // (incluye el boton y el auto-print para "Descargar PDF" aunque el reporte sea antiguo).
    const raw = fs.readFileSync(backupPath);
    const payload = JSON.parse(gunzipSync(raw).toString('utf-8')) as AnnualArchivePayload;
    const reportFileName = backupFileName.replace(/\.json\.gz$/, '.html');
    const reportPath = join(this.annualArchiveDir, reportFileName);
    fs.writeFileSync(reportPath, this.buildAnnualReportHtml(payload), 'utf-8');

    return {
      ...manifest,
      backupFileName,
      backupUrl,
      fileName: reportFileName,
      fileUrl: `/uploads/annual-archives/${reportFileName}`,
      reportFileName,
      reportUrl: `/uploads/annual-archives/${reportFileName}`,
    };
  }

  private ensureMeetingEditableBeforeAttendanceStarts(meeting: {
    isClosed: boolean;
    status: Status;
    attendanceOpensAt: Date | null;
    date: Date;
  }): void {
    this.ensureAcademicYearOpenByDate(meeting.date);
    this.ensureMeetingEditable(meeting.isClosed);

    if (
      meeting.status === Status.EN_CURSO ||
      meeting.status === Status.FINALIZADA ||
      meeting.status === Status.CANCELADA
    ) {
      throw new ForbiddenException('La reunion ya inicio o fue cerrada y no admite ediciones');
    }

    if (meeting.attendanceOpensAt && new Date() >= meeting.attendanceOpensAt) {
      throw new ForbiddenException('Solo puedes enviar  solicitud de puntos antes de inicio de la toma de asistencias');
    }
  }

  private isAgendaProposalWindowOpen(meetingDate: Date): boolean {
    const closeAt = new Date(
      meetingDate.getTime() - MeetingService.AGENDA_PROPOSAL_HOURS_BEFORE_MEETING * 60 * 60 * 1000,
    );
    return new Date() < closeAt;
  }

  private async refreshQuorum(meetingId: string): Promise<void> {
    // Se recalcula con la fila bloqueada: dos marcas de asistencia simultaneas no pueden
    // dejar un hasQuorum calculado con datos viejos.
    await prisma.$transaction(async (tx) => {
      await this.lockMeeting(tx, meetingId);

      const meeting = await tx.meeting.findUniqueOrThrow({
        where: { id: meetingId },
        select: {
          meetingCategory: true,
          organizerId: true,
          attendance: {
            select: {
              status: true,
              userId: true,
              user: {
                select: {
                  role: true,
                },
              },
            },
          },
        },
      });

      // Preside la secretaria; si no hay ninguna convocada, preside la coordinacion organizadora.
      const secretaryInvited = meeting.attendance.some((entry) => entry.user.role === Role.SECRETARIO);
      const isPresiding = (entry: (typeof meeting.attendance)[number]) =>
        secretaryInvited
          ? entry.user.role === Role.SECRETARIO
          : entry.user.role === Role.ADMIN && entry.userId === meeting.organizerId;

      const presentEntries = meeting.attendance.filter((entry) => entry.status === AttendanceStatus.PRESENTE);
      const presidingPresent = presentEntries.some(isPresiding);
      const participantPresent = presentEntries.some((entry) => !isPresiding(entry));
      const quorumMinimo = this.quorumMinimum(meeting.meetingCategory);

      const hasQuorum =
        meeting.meetingCategory === MeetingCategory.ASAMBLEA
          ? presidingPresent
          : presidingPresent && participantPresent;

      await tx.meeting.update({
        where: { id: meetingId },
        data: { quorumMinimo, hasQuorum },
      });
    });
  }

  async create(moderatorId: string, dto: CreateMeetingDto) {
    const invitedUserIds = dto.invitedUserIds ?? [];
    const baseAgendaPoints = dto.baseAgendaPoints ?? [];
    const quorumMinimo = this.quorumMinimum(dto.meetingCategory);
    const date = new Date(dto.date);
    this.ensureAcademicYearOpenByDate(date);
    this.ensureMeetingSchedule(date);
    const attendanceOpensAt = new Date(date.getTime() - this.attendanceOpenMinutesBefore * 60 * 1000);

    const meeting = await prisma.meeting.create({
      data: {
        title: dto.title,
        description: dto.description,
        date,
        location: dto.location,
        meetingType: dto.meetingType,
        meetingCategory: dto.meetingCategory,
        modality: dto.modality,
        organizerId: moderatorId,
        quorumMinimo,
        hasQuorum: false,
        attendanceOpensAt,
        attendanceClosesAt: date,
        attendance: {
          create: invitedUserIds.map((userId) => ({ userId, status: AttendanceStatus.PENDIENTE })),
        },
        agendaPoints: {
          create: this.buildBaseAgendaPoints(baseAgendaPoints),
        },
      },
      include: this.meetingInclude,
    });

    await this.sendMeetingEmailNotification(meeting, 'created');
    return this.mapMeetingView(meeting);
  }

  async findAll() {
    const meetings = await prisma.meeting.findMany({
      include: this.meetingInclude,
      orderBy: { date: 'desc' },
    });

    return meetings.map((meeting) => ({
      ...this.mapMeetingView(meeting),
      previousMinute: this.previousMinuteFrom(this.findPreviousClosedMeeting(meeting, meetings)),
    }));
  }

  async findOne(id: string) {
    const meeting = await prisma.meeting.findUnique({
      where: { id },
      include: this.meetingInclude,
    });

    if (!meeting) {
      return null;
    }

    const previous = await prisma.meeting.findFirst({
      where: {
        id: { not: meeting.id },
        meetingCategory: meeting.meetingCategory,
        isClosed: true,
        date: { lt: meeting.date },
      },
      orderBy: { date: 'desc' },
      include: { agendaPoints: true },
    });

    return {
      ...this.mapMeetingView(meeting),
      previousMinute: this.previousMinuteFrom(previous),
    };
  }

  async findAvailableAgendaForUser(userId: string, userRole: string, meetingId?: string) {
    const isPrivileged = userRole === 'ADMIN' || userRole === 'SECRETARIO';
    const now = new Date();
    // La recepción de agenda es para reuniones PROGRAMADAS que aún no inician.
    // Se excluyen EN_CURSO y pasadas (p. ej. actas viejas atascadas en curso) para que no
    // "tapen" a las reuniones reales que sí están abiertas a recibir puntos.
    const openMeetings = await prisma.meeting.findMany({
      where: {
        agendaConsolidated: false,
        isClosed: false,
        status: Status.PROGRAMADA,
        date: { gt: now },
      },
      include: this.meetingInclude,
      orderBy: { date: 'asc' },
    });

    const meetingOptions = openMeetings.map((option) => ({
      id: option.id,
      title: option.title,
      date: option.date,
      category: option.meetingCategory,
    }));

    const meeting =
      (meetingId ? openMeetings.find((option) => option.id === meetingId) : null) ||
      openMeetings[0] ||
      null;

    if (!meeting) {
      return {
        available: false,
        maxPointsPerUser: MeetingService.MAX_POINTS_PER_USER,
        meeting: null,
        meetingOptions,
        message: 'No hay un acta disponible para registrar puntos en este momento.',
        myProposalCount: 0,
        myProposals: [],
        remainingSlots: 0,
      };
    }

    const hasExplicitInvitees = meeting.attendance.length > 0;
    const isInvited = meeting.attendance.some((entry) => entry.userId === userId);

    if (hasExplicitInvitees && !isInvited) {
      return {
        available: false,
        maxPointsPerUser: MeetingService.MAX_POINTS_PER_USER,
        meeting: this.mapMeetingView(meeting),
        meetingOptions,
        message: 'Existe un acta abierta, pero no formas parte de los invitados para esta agenda.',
        myProposalCount: 0,
        myProposals: [],
        remainingSlots: 0,
      };
    }

    const myProposals = meeting.agendaPoints.filter((point) => point.proposerId === userId);
    const myProposalCount = myProposals.length;

    if (!isPrivileged && !this.isAgendaProposalWindowOpen(meeting.date)) {
      return {
        available: false,
        maxPointsPerUser: MeetingService.MAX_POINTS_PER_USER,
        meeting: this.mapMeetingView(meeting),
        meetingOptions,
        message: 'La recepción de puntos se cierra 24 horas antes de la reunión para revisión de secretaría.',
        myProposalCount,
        myProposals,
        remainingSlots: 0,
      };
    }

    const remainingSlots = isPrivileged
      ? 99
      : Math.max(0, MeetingService.MAX_POINTS_PER_USER - myProposalCount);

    return {
      available: true,
      maxPointsPerUser: isPrivileged ? 99 : MeetingService.MAX_POINTS_PER_USER,
      meeting: this.mapMeetingView(meeting),
      meetingOptions,
      message: null,
      myProposalCount,
      myProposals,
      remainingSlots,
    };
  }

  async updateLogistics(id: string, dto: UpdateMeetingLogisticsDto) {
    const meeting = await this.getMeetingOrThrow(id);
    this.ensureMeetingEditableBeforeAttendanceStarts(meeting);

    if (dto.status === Status.CANCELADA) {
      throw new BadRequestException(
        'Para cancelar una reunión usa la opción Cancelar con motivo',
      );
    }

    const nextDate = dto.date ? new Date(dto.date) : null;
    if (nextDate) {
      this.ensureMeetingSchedule(nextDate);
    }
    const nextAttendanceOpensAt = nextDate
      ? new Date(nextDate.getTime() - this.attendanceOpenMinutesBefore * 60 * 1000)
      : null;

    const updated = await prisma.meeting.update({
      where: { id },
      data: {
        title: dto.title,
        description: dto.description,
        date: nextDate ?? undefined,
        attendanceOpensAt: nextAttendanceOpensAt ?? undefined,
        attendanceClosesAt: nextDate ?? undefined,
        location: dto.location,
        meetingType: dto.meetingType,
        meetingCategory: dto.meetingCategory,
        modality: dto.modality,
        status: dto.status,
      },
      include: this.meetingInclude,
    });

    await this.sendMeetingEmailNotification(updated, 'updated');
    return this.mapMeetingView(updated);
  }

  async cancelMeeting(id: string, userId: string, dto: CancelMeetingDto) {
    const meeting = await this.getMeetingOrThrow(id);
    this.ensureAcademicYearOpenByDate(meeting.date);

    const updated = await prisma.$transaction(async (tx) => {
      // Con la fila bloqueada, ningun mensaje ni voto puede colarse durante la cancelacion.
      const locked = await this.lockMeeting(tx, id);

      if (locked.isClosed || locked.status === Status.FINALIZADA) {
        throw new ForbiddenException('No se puede cancelar una reunión finalizada');
      }

      if (locked.status === Status.CANCELADA) {
        throw new ForbiddenException('La reunión ya está cancelada');
      }

      const now = new Date();
      await tx.poll.updateMany({
        where: { meetingId: id, status: PollStatus.OPEN },
        data: { status: PollStatus.CLOSED, closedAt: now },
      });

      return tx.meeting.update({
        where: { id },
        data: {
          status: Status.CANCELADA,
          votingOpen: false,
          cancellationReason: dto.reason,
          cancelledAt: now,
          cancelledById: userId,
        },
        include: this.meetingInclude,
      });
    });

    return this.mapMeetingView(updated);
  }

  async setInvitees(id: string, dto: SetInviteesDto) {
    const meeting = await this.getMeetingOrThrow(id);
    this.ensureMeetingEditableBeforeAttendanceStarts(meeting);

    await prisma.$transaction(async (tx) => {
      await tx.attendance.deleteMany({ where: { meetingId: id } });

      if (dto.invitedUserIds.length > 0) {
        await tx.attendance.createMany({
          data: dto.invitedUserIds.map((userId) => ({ meetingId: id, userId, status: AttendanceStatus.PENDIENTE })),
          skipDuplicates: true,
        });
      }
    });

    await this.refreshQuorum(id);
    return this.findOne(id);
  }

  async markAttendance(id: string, userId: string, dto: MarkAttendanceDto) {
    const meeting = await this.getMeetingOrThrow(id);
    this.ensureAcademicYearOpenByDate(meeting.date);
    this.ensureMeetingEditable(meeting.isClosed);

    if (!meeting.attendanceOpensAt || !meeting.attendanceClosesAt) {
      throw new BadRequestException('La asistencia de esta reunion no esta configurada');
    }

    if (meeting.status === Status.CANCELADA) {
      throw new BadRequestException('La reunion fue cancelada');
    }

    // Secretaria puede registrar o corregir asistencia (llegadas tarde, justificativos)
    // desde que abre la ventana hasta que la reunion se cierra.
    if (new Date() < meeting.attendanceOpensAt) {
      throw new BadRequestException('La ventana de asistencia aun no se ha abierto');
    }

    // Solo se registra asistencia de convocados; los invitados se gestionan con setInvitees.
    const updated = await prisma.attendance.updateMany({
      where: { userId, meetingId: id },
      data: {
        status: dto.status,
        excuse: dto.excuse,
        markedAt: new Date(),
      },
    });

    if (updated.count === 0) {
      throw new NotFoundException('El usuario no esta convocado a esta reunion');
    }

    await this.refreshQuorum(id);
    await this.triggerAbsenceThresholdAlerts(id);
    return this.findOne(id);
  }

  async confirmAttendanceForUser(meetingId: string, userId: string) {
    const meeting = await this.getMeetingOrThrow(meetingId);
    this.ensureAcademicYearOpenByDate(meeting.date);
    this.ensureMeetingEditable(meeting.isClosed);

    if (meeting.status === Status.CANCELADA) {
      throw new BadRequestException('La reunion fue cancelada');
    }

    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    const canConfirmAttendance =
      currentUser?.role === Role.ADMIN ||
      currentUser?.role === Role.DOCENTE ||
      currentUser?.role === Role.SECRETARIO;

    if (!canConfirmAttendance) {
      throw new ForbiddenException('Solo los docentes y secretarios del sistema pueden confirmar asistencia');
    }

    if (!meeting.attendanceOpensAt || !meeting.attendanceClosesAt) {
      throw new BadRequestException('La asistencia de esta reunion no esta configurada');
    }

    const now = new Date();
    if (now < meeting.attendanceOpensAt || now > meeting.attendanceClosesAt) {
      throw new BadRequestException('La ventana de asistencia no esta activa');
    }

    const attendanceAlreadyFinalized = meeting.attendanceFinalized || now > meeting.attendanceClosesAt;
    if (attendanceAlreadyFinalized) {
      throw new BadRequestException('La ventana de asistencia ya fue cerrada');
    }

    const entry = await prisma.attendance.findUnique({
      where: { userId_meetingId: { userId, meetingId } },
      select: { status: true },
    });

    if (!entry) {
      throw new ForbiddenException('No estas convocado a esta reunion');
    }

    // Una ausencia o justificacion registrada por secretaria no se pisa con el autoregistro.
    if (entry.status === AttendanceStatus.AUSENTE || entry.status === AttendanceStatus.JUSTIFICADA) {
      throw new BadRequestException('Tu asistencia ya fue registrada por secretaria');
    }

    if (entry.status !== AttendanceStatus.PRESENTE) {
      await prisma.attendance.updateMany({
        where: { userId, meetingId, status: AttendanceStatus.PENDIENTE },
        data: {
          status: AttendanceStatus.PRESENTE,
          excuse: null,
          markedAt: new Date(),
        },
      });
    }

    await this.refreshQuorum(meetingId);
    return this.findOne(meetingId);
  }

  async finalizeAttendance(id: string) {
    const meeting = await this.getMeetingOrThrow(id);
    this.ensureAcademicYearOpenByDate(meeting.date);

    if (!meeting.attendanceClosesAt) {
      throw new BadRequestException('La reunion no tiene cierre de asistencia configurado');
    }

    if (meeting.isClosed || meeting.status === Status.CANCELADA) {
      throw new BadRequestException('No se puede finalizar la asistencia de una reunion cerrada o cancelada');
    }

    const now = new Date();
    if (now < meeting.attendanceClosesAt) {
      throw new BadRequestException('Aun no termina la ventana de asistencia');
    }

    // El flag se marca de forma condicional: si dos llamadas compiten (scheduler y boton
    // manual), solo una convierte los pendientes en ausentes y dispara las alertas.
    const finalizedNow = await prisma.$transaction(async (tx) => {
      const flagged = await tx.meeting.updateMany({
        where: { id, attendanceFinalized: false },
        data: {
          attendanceFinalized: true,
          attendanceFinalizedAt: now,
        },
      });

      if (flagged.count === 0) {
        return false;
      }

      await tx.attendance.updateMany({
        where: {
          meetingId: id,
          status: AttendanceStatus.PENDIENTE,
        },
        data: {
          status: AttendanceStatus.AUSENTE,
        },
      });

      return true;
    });

    if (!finalizedNow) {
      return this.findOne(id);
    }

    await this.refreshQuorum(id);
    await this.triggerAbsenceThresholdAlerts(id);
    return this.findOne(id);
  }

  async proposeAgendaPoint(id: string, teacherId: string, dto: ProposeAgendaPointDto) {
    const meeting = await this.getMeetingOrThrow(id);
    this.ensureMeetingEditableBeforeAttendanceStarts(meeting);

    if (
      meeting.agendaConsolidated ||
      meeting.status === Status.CANCELADA ||
      meeting.status === Status.FINALIZADA
    ) {
      throw new BadRequestException('El acta seleccionada ya no esta disponible para registrar puntos');
    }

    const proposer = await prisma.user.findUnique({ where: { id: teacherId }, select: { role: true } });
    const isPrivileged = proposer?.role === 'ADMIN' || proposer?.role === 'SECRETARIO';

    if (!isPrivileged && !this.isAgendaProposalWindowOpen(meeting.date)) {
      throw new BadRequestException(
        'La recepción de puntos se cierra 24 horas antes de la reunión para revisión de secretaría',
      );
    }

    if (!isPrivileged) {
      const inviteeCount = await prisma.attendance.count({ where: { meetingId: id } });
      if (inviteeCount > 0) {
        const isInvited = await prisma.attendance.count({ where: { meetingId: id, userId: teacherId } });
        if (isInvited === 0) {
          throw new ForbiddenException('Solo los invitados de esta acta pueden registrar puntos');
        }
      }
    }

    if (!isPrivileged) {
      const teacherProposalCount = await prisma.agendaPoint.count({
        where: {
          meetingId: id,
          proposerId: teacherId,
        },
      });

      if (teacherProposalCount >= MeetingService.MAX_POINTS_PER_USER) {
        throw new BadRequestException(
          `Cada participante solo puede proponer hasta ${MeetingService.MAX_POINTS_PER_USER} puntos por reunion`,
        );
      }
    }

    return prisma.agendaPoint.create({
      data: {
        title: dto.title,
        description: dto.description,
        status: isPrivileged ? AgendaStatus.APROBADO : AgendaStatus.PENDIENTE,
        meetingId: id,
        proposerId: teacherId,
        isBasePoint: isPrivileged,
      },
    });
  }

  async reviewAgendaPoint(id: string, proposalId: string, reviewerId: string, dto: ReviewAgendaPointDto) {
    if (dto.status === AgendaStatus.PENDIENTE) {
      throw new BadRequestException('Solo se permite aprobar o rechazar propuestas');
    }

    const meeting = await this.getMeetingOrThrow(id);
    this.ensureMeetingEditableBeforeAttendanceStarts(meeting);

    const proposal = await prisma.agendaPoint.findFirst({
      where: { id: proposalId, meetingId: id },
    });

    if (!proposal) {
      throw new NotFoundException('Propuesta no encontrada para esta reunion');
    }

    if (proposal.proposerId === reviewerId) {
      throw new ForbiddenException('No puedes aprobar o rechazar tus propios puntos de agenda');
    }

    const reviewComment = dto.reviewComment?.trim() || null;
    if (dto.status === AgendaStatus.RECHAZADO && !reviewComment) {
      throw new BadRequestException('Debes indicar el motivo del rechazo');
    }

    return prisma.agendaPoint.update({
      where: { id: proposalId },
      data: { status: dto.status, reviewComment },
    });
  }

  async consolidateAgenda(id: string) {
    const meeting = await this.getMeetingOrThrow(id);
    this.ensureMeetingEditableBeforeAttendanceStarts(meeting);

    await prisma.meeting.update({
      where: { id },
      data: { agendaConsolidated: true },
    });

    const approved = await prisma.agendaPoint.findMany({
      where: { meetingId: id, status: AgendaStatus.APROBADO },
      orderBy: { createdAt: 'asc' },
    });

    const pending = await prisma.agendaPoint.count({
      where: { meetingId: id, status: AgendaStatus.PENDIENTE },
    });

    return {
      meetingId: id,
      approvedAgenda: approved,
      pendingCount: pending,
      consolidatedAt: new Date().toISOString(),
    };
  }

  // Valida que la reunion admita evidencia antes de subir el archivo al almacenamiento.
  async ensureEvidenceUploadAllowed(id: string) {
    const meeting = await this.getMeetingOrThrow(id);
    this.ensureAcademicYearOpenByDate(meeting.date);
    this.ensureMeetingEditable(meeting.isClosed);

    if (meeting.status !== Status.EN_CURSO) {
      throw new BadRequestException('El acta firmada solo se puede cargar durante una reunion en curso');
    }

    return meeting;
  }

  // Guarda la referencia del archivo ya subido y devuelve la anterior para que se elimine.
  async setEvidenceReference(id: string, reference: string) {
    const { updated, previousReference } = await prisma.$transaction(async (tx) => {
      const locked = await this.lockMeeting(tx, id);
      if (locked.isClosed || locked.status !== Status.EN_CURSO) {
        throw new BadRequestException('El acta firmada solo se puede cargar durante una reunion en curso');
      }

      const current = await tx.meeting.findUniqueOrThrow({
        where: { id },
        select: { evidenceSignaturesUrl: true },
      });

      const saved = await tx.meeting.update({
        where: { id },
        data: { evidenceSignaturesUrl: reference },
        include: this.meetingInclude,
      });

      return { updated: saved, previousReference: current.evidenceSignaturesUrl };
    });

    return { meeting: this.mapMeetingView(updated), previousReference };
  }

  async getEvidenceReference(id: string, userId: string, userRole: string) {
    await this.ensureUserCanAccessMeetingContext(id, userId, userRole);
    const meeting = await prisma.meeting.findUniqueOrThrow({
      where: { id },
      select: { evidenceSignaturesUrl: true },
    });

    if (!meeting.evidenceSignaturesUrl) {
      throw new NotFoundException('La reunion no tiene acta firmada cargada');
    }

    return meeting.evidenceSignaturesUrl;
  }

  async startVoting(id: string, userId: string) {
    const meeting = await this.getMeetingOrThrow(id);
    this.ensureAcademicYearOpenByDate(meeting.date);

    const updated = await prisma.$transaction(async (tx) => {
      const locked = await this.lockMeeting(tx, id);

      if (locked.isClosed || locked.status !== Status.EN_CURSO) {
        throw new BadRequestException('La votacion solo puede iniciarse durante una reunion en curso');
      }
      if (locked.votingOpen) {
        throw new ConflictException('La fase de votacion ya fue iniciada');
      }
      if (!locked.attendanceFinalized) {
        throw new BadRequestException('Debe finalizarse la asistencia antes de iniciar la votacion');
      }
      if (!locked.hasQuorum) {
        throw new BadRequestException('La reunion no tiene quorum; no se puede iniciar la votacion');
      }

      return tx.meeting.update({
        where: { id },
        data: { votingOpen: true, votingStartedAt: new Date(), votingStartedById: userId },
        include: this.meetingInclude,
      });
    });

    return this.mapMeetingView(updated);
  }

  async closeMeeting(id: string) {
    const meeting = await this.getMeetingOrThrow(id);
    this.ensureAcademicYearOpenByDate(meeting.date);

    const { closed, closedPollIds } = await prisma.$transaction(async (tx) => {
      // Bloqueo exclusivo: chat y votos esperan a que termine el cierre y luego ven FINALIZADA.
      const locked = await this.lockMeeting(tx, id);
      this.ensureMeetingEditable(locked.isClosed);

      if (locked.status !== Status.EN_CURSO) {
        throw new BadRequestException('Solo se puede finalizar una reunion en curso');
      }

      const current = await tx.meeting.findUniqueOrThrow({
        where: { id },
        include: this.meetingInclude,
      });

      if (!current.evidenceSignaturesUrl) {
        throw new BadRequestException('Debe cargarse el acta firmada antes de finalizar la reunion');
      }

      const openPolls = await tx.poll.findMany({
        where: { meetingId: id, status: PollStatus.OPEN },
        select: { id: true },
      });
      const now = new Date();
      await tx.poll.updateMany({
        where: { meetingId: id, status: PollStatus.OPEN },
        data: { status: PollStatus.CLOSED, closedAt: now },
      });

      const totalInvited = current.attendance.length;
      const presentCount = current.attendance.filter((entry) => entry.status === AttendanceStatus.PRESENTE).length;
      const approvedAgendaCount = current.agendaPoints.filter((point) => point.status === AgendaStatus.APROBADO).length;
      const summary = [
        `Resumen final de la reunion ${current.title}.`,
        `Asistentes registrados: ${presentCount}/${totalInvited}.`,
        `Puntos aprobados en el orden del dia: ${approvedAgendaCount}.`,
        `Acta firmada cargada al sistema.`,
      ].join(' ');

      const updated = await tx.meeting.update({
        where: { id },
        data: {
          isClosed: true,
          closedAt: now,
          finalSummary: summary,
          status: Status.FINALIZADA,
          votingOpen: false,
        },
        include: this.meetingInclude,
      });

      return { closed: updated, closedPollIds: openPolls.map((poll) => poll.id) };
    });

    const closedPolls = await Promise.all(closedPollIds.map((pollId) => this.getPollView(pollId)));
    return { meeting: this.mapMeetingView(closed), closedPolls };
  }

  private dayKeyInInstitutionalZone(date: Date): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: MeetingService.TZ }).format(date);
  }

  // Reuniones que siguen programadas aunque su dia ya paso (p. ej. el servidor estuvo apagado).
  async autoCancelExpiredMeetings() {
    const now = new Date();
    const todayKey = this.dayKeyInInstitutionalZone(now);

    const candidates = await prisma.meeting.findMany({
      where: { isClosed: false, status: Status.PROGRAMADA, date: { lt: now } },
      select: { id: true, date: true },
    });

    const expired = candidates.filter((meeting) => this.dayKeyInInstitutionalZone(meeting.date) < todayKey);
    const cancelledIds: string[] = [];

    // Una por una y condicionada al estado: si alguien la modifico entre la lectura y la
    // escritura, se respeta su cambio.
    for (const meeting of expired) {
      const result = await prisma.meeting.updateMany({
        where: { id: meeting.id, isClosed: false, status: Status.PROGRAMADA },
        data: {
          status: Status.CANCELADA,
          cancellationReason: MeetingService.AUTO_CANCEL_REASON,
          cancelledAt: now,
        },
      });
      if (result.count > 0) {
        cancelledIds.push(meeting.id);
      }
    }

    return { cancelledMeetings: cancelledIds.length, cancelledIds };
  }

  async syncAttendanceWindows() {
    const now = new Date();

    const dueMeetings = await prisma.meeting.findMany({
      where: { isClosed: false, status: Status.PROGRAMADA, date: { lte: now } },
      select: { id: true },
    });

    const activatedIds: string[] = [];
    for (const meeting of dueMeetings) {
      const result = await prisma.meeting.updateMany({
        where: { id: meeting.id, isClosed: false, status: Status.PROGRAMADA },
        data: { status: Status.EN_CURSO },
      });
      if (result.count > 0) {
        activatedIds.push(meeting.id);
      }
    }

    const pendingMeetings = await prisma.meeting.findMany({
      where: {
        isClosed: false,
        attendanceFinalized: false,
        status: { not: Status.CANCELADA },
        attendanceClosesAt: {
          lte: now,
        },
      },
      select: { id: true },
    });

    const finalizedIds: string[] = [];
    const failures: Array<{ id: string; error: string }> = [];
    for (const meeting of pendingMeetings) {
      // Un fallo en una reunion (p. ej. año lectivo cerrado) no detiene a las demas.
      try {
        await this.finalizeAttendance(meeting.id);
        finalizedIds.push(meeting.id);
      } catch (error) {
        failures.push({ id: meeting.id, error: (error as Error).message });
      }
    }

    return {
      activatedMeetings: activatedIds.length,
      activatedIds,
      finalizedMeetings: finalizedIds.length,
      finalizedIds,
      failures,
    };
  }

  async closeAnnualYear(year: number, closedByUserId: string) {
    const existing = this.readAnnualArchiveIndex();
    if (existing.some((entry) => entry.year === year)) {
      throw new BadRequestException(`El año lectivo ${year} ya fue cerrado`);
    }

    const from = new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0));
    const to = new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0, 0));

    const meetings = await prisma.meeting.findMany({
      where: {
        date: {
          gte: from,
          lt: to,
        },
      },
      include: this.meetingInclude,
      orderBy: { date: 'asc' },
    });

    const closedAt = new Date().toISOString();
    const archiveData: AnnualArchivePayload = {
      closedAt,
      closedByUserId,
      meetings: meetings.map((meeting) => ({
        agendaConsolidated: meeting.agendaConsolidated,
        agendaPoints: meeting.agendaPoints.map((point) => ({
          createdAt: point.createdAt,
          description: point.description,
          id: point.id,
          isBasePoint: point.isBasePoint,
          proposer: point.proposer
            ? {
                id: point.proposer.id,
                name: point.proposer.name,
                role: point.proposer.role,
              }
            : null,
          reviewComment: point.reviewComment,
          status: point.status,
          title: point.title,
          updatedAt: point.updatedAt,
        })),
        attendance: meeting.attendance.map((entry) => ({
          excuse: entry.excuse,
          markedAt: entry.markedAt,
          status: entry.status,
          user: {
            email: entry.user.email,
            id: entry.user.id,
            name: entry.user.name,
            role: entry.user.role,
          },
        })),
        attendanceFinalized: meeting.attendanceFinalized,
        cancellationReason: meeting.cancellationReason,
        category: meeting.meetingCategory,
        closedAt: meeting.closedAt,
        date: meeting.date,
        description: meeting.description,
        evidenceSignaturesUrl: meeting.evidenceSignaturesUrl,
        finalSummary: meeting.finalSummary,
        hasQuorum: meeting.hasQuorum,
        id: meeting.id,
        isClosed: meeting.isClosed,
        location: meeting.location,
        modality: meeting.modality,
        organizer: {
          email: meeting.organizer.email,
          id: meeting.organizer.id,
          name: meeting.organizer.name,
          role: meeting.organizer.role,
        },
        quorumMinimo: meeting.quorumMinimo,
        status: meeting.status,
        title: meeting.title,
      })),
      stats: {
        approvedPoints: meetings.reduce(
          (acc, meeting) =>
            acc + meeting.agendaPoints.filter((point) => point.status === AgendaStatus.APROBADO).length,
          0,
        ),
        meetingsClosed: meetings.filter((meeting) => meeting.isClosed).length,
        meetingsTotal: meetings.length,
        presentMarks: meetings.reduce(
          (acc, meeting) =>
            acc + meeting.attendance.filter((entry) => entry.status === AttendanceStatus.PRESENTE).length,
          0,
        ),
      },
      year,
    };

    const json = JSON.stringify(archiveData, null, 2);
    const compressed = gzipSync(Buffer.from(json, 'utf-8'), { level: 9 });
    const stamp = Date.now();
    const backupFileName = `annual-archive-${year}-${stamp}.json.gz`;
    const reportFileName = `annual-report-${year}-${stamp}.html`;
    fs.mkdirSync(this.annualArchiveDir, { recursive: true });
    fs.writeFileSync(join(this.annualArchiveDir, backupFileName), compressed);
    fs.writeFileSync(join(this.annualArchiveDir, reportFileName), this.buildAnnualReportHtml(archiveData), 'utf-8');

    const manifest: AnnualArchiveManifest = {
      checksumSha256: createHash('sha256').update(compressed).digest('hex'),
      closedAt,
      closedByUserId,
      backupFileName,
      backupUrl: `/uploads/annual-archives/${backupFileName}`,
      fileName: reportFileName,
      fileUrl: `/uploads/annual-archives/${reportFileName}`,
      meetingsCount: meetings.length,
      reportFileName,
      reportUrl: `/uploads/annual-archives/${reportFileName}`,
      year,
    };

    this.writeAnnualArchiveIndex([...existing, manifest]);
    return manifest;
  }

  listAnnualArchives() {
    const current = this.readAnnualArchiveIndex();
    const migrated = current.map((entry) => this.ensureReadableAnnualReport(entry));

    if (JSON.stringify(current) !== JSON.stringify(migrated)) {
      this.writeAnnualArchiveIndex(migrated);
    }

    return migrated.sort((a, b) => b.year - a.year);
  }

  getAnnualArchiveData(year: number): AnnualArchivePayload {
    const entry = this.readAnnualArchiveIndex().find((item) => item.year === year);
    if (!entry) {
      throw new NotFoundException(`No existe un cierre anual para el año ${year}`);
    }

    const backupFileName = entry.backupFileName || entry.fileName;
    const backupPath = join(this.annualArchiveDir, backupFileName);
    if (!backupFileName.endsWith('.json.gz') || !fs.existsSync(backupPath)) {
      throw new NotFoundException('No se encontró el respaldo de datos del cierre anual');
    }

    const raw = fs.readFileSync(backupPath);
    return JSON.parse(gunzipSync(raw).toString('utf-8')) as AnnualArchivePayload;
  }

  async generateAnnualReportPdf(year: number): Promise<Buffer> {
    const payload = this.getAnnualArchiveData(year);
    const html = this.buildAnnualReportHtml(payload);
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' },
      });
      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }

  async listAbsenceAlerts() {
    return prisma.absenceAlert.findMany({
      include: {
        meeting: {
          select: {
            id: true,
            date: true,
            title: true,
          },
        },
        teacher: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        reviewedBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
      orderBy: { notifiedAt: 'desc' },
      take: 100,
    });
  }

  async listMyNotifications(userId: string) {
    const recipients = await prisma.notificationRecipient.findMany({
      where: {
        dismissedAt: null,
        userId,
      },
      include: {
        notification: {
          include: {
            absenceAlert: {
              include: {
                teacher: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: {
        notification: {
          createdAt: 'desc',
        },
      },
      take: 100,
    });

    return recipients.map((recipient) => ({
      actionHref: recipient.notification.actionHref,
      createdAt: recipient.notification.createdAt,
      id: recipient.id,
      message: recipient.notification.message,
      notificationId: recipient.notificationId,
      payload: recipient.notification.absenceAlert
        ? {
            absenceAlertId: recipient.notification.absenceAlert.id,
            absencesCount: recipient.notification.absenceAlert.absencesCount,
            teacher: recipient.notification.absenceAlert.teacher,
          }
        : null,
      read: Boolean(recipient.readAt),
      readAt: recipient.readAt,
      title: recipient.notification.title,
      type: recipient.notification.type === NotificationType.ABSENCE_ALERT ? 'warning' : 'info',
    }));
  }

  async markNotificationAsRead(recipientId: string, userId: string) {
    const recipient = await prisma.notificationRecipient.findFirst({
      where: {
        id: recipientId,
        userId,
      },
    });

    if (!recipient) {
      throw new NotFoundException('Notificación no encontrada');
    }

    return prisma.notificationRecipient.update({
      where: { id: recipientId },
      data: {
        readAt: recipient.readAt || new Date(),
      },
    });
  }

  async markAllNotificationsAsRead(userId: string) {
    const result = await prisma.notificationRecipient.updateMany({
      where: {
        dismissedAt: null,
        readAt: null,
        userId,
      },
      data: {
        readAt: new Date(),
      },
    });

    return {
      updatedCount: result.count,
    };
  }

  async dismissNotification(recipientId: string, userId: string) {
    const recipient = await prisma.notificationRecipient.findFirst({
      where: {
        id: recipientId,
        userId,
      },
    });

    if (!recipient) {
      throw new NotFoundException('Notificación no encontrada');
    }

    return prisma.notificationRecipient.update({
      where: { id: recipientId },
      data: {
        dismissedAt: new Date(),
        readAt: recipient.readAt || new Date(),
      },
    });
  }

  async reviewAbsenceAlert(alertId: string, reviewerId: string, dto: ReviewAbsenceAlertDto) {
    const alert = await prisma.absenceAlert.findUnique({
      where: { id: alertId },
    });

    if (!alert) {
      throw new NotFoundException('Alerta de inasistencia no encontrada');
    }

    const reviewedAt = new Date();
    const reviewNotes = dto.reviewNotes?.trim() || null;

    const updated = await prisma.absenceAlert.update({
      where: { id: alertId },
      data: {
        reviewNotes,
        reviewedAt,
        reviewedById: reviewerId,
        reviewStatus: dto.status,
      },
      include: {
        meeting: {
          select: {
            id: true,
            date: true,
            title: true,
          },
        },
        teacher: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        reviewedBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    await prisma.notificationRecipient.updateMany({
      where: {
        notification: {
          absenceAlertId: alertId,
        },
        userId: reviewerId,
      },
      data: {
        readAt: reviewedAt,
      },
    });

    return updated;
  }

  async remove(id: string) {
    const meeting = await this.getMeetingOrThrow(id);

    if (meeting.isClosed || meeting.status === Status.FINALIZADA) {
      throw new BadRequestException('Una reunion finalizada forma parte del historial y no se puede eliminar');
    }

    return prisma.$transaction(async (tx) => {
      await tx.pollVote.deleteMany({ where: { poll: { meetingId: id } } });
      await tx.poll.deleteMany({ where: { meetingId: id } });
      await tx.chatMessage.deleteMany({ where: { meetingId: id } });
      await tx.agendaPoint.deleteMany({ where: { meetingId: id } });
      await tx.attendance.deleteMany({ where: { meetingId: id } });
      await tx.actionItem.deleteMany({ where: { meetingId: id } });
      await tx.minute.deleteMany({ where: { meetingId: id } });
      await tx.absenceAlert.updateMany({ where: { meetingId: id }, data: { meetingId: null } });
      return tx.meeting.delete({ where: { id } });
    });
  }

  async ensureUserCanAccessMeetingContext(meetingId: string, userId: string, userRole: string) {
    const meeting = await prisma.meeting.findUnique({
      where: { id: meetingId },
      select: {
        id: true,
        organizerId: true,
        status: true,
        isClosed: true,
        hasQuorum: true,
        votingOpen: true,
        attendance: { select: { userId: true, status: true } },
      },
    });

    if (!meeting) {
      throw new NotFoundException('Reunion no encontrada');
    }

    if (userRole === Role.ADMIN || userRole === Role.SECRETARIO || meeting.organizerId === userId) {
      return meeting;
    }

    const isInvited = meeting.attendance.some((entry) => entry.userId === userId);
    if (meeting.attendance.length > 0 && !isInvited) {
      throw new ForbiddenException('No tienes acceso al chat de esta reunion');
    }

    return meeting;
  }

  /**
   * Acceso al chat y las votaciones de la reunion. Secretaria y coordinacion entran siempre
   * (con la reunion cerrada, solo en lectura). Un docente solo entra mientras la reunion esta
   * abierta y si su asistencia quedo confirmada como presente.
   */
  async ensureUserCanAccessMeetingChat(meetingId: string, userId: string, userRole: string) {
    const meeting = await this.ensureUserCanAccessMeetingContext(meetingId, userId, userRole);

    if (userRole === Role.ADMIN || userRole === Role.SECRETARIO) {
      return meeting;
    }

    if (this.isMeetingReadOnly(meeting)) {
      throw new ForbiddenException(
        'La reunion ya fue cerrada; solo Secretaria y Coordinacion pueden consultar su chat',
      );
    }

    const entry = meeting.attendance.find((item) => item.userId === userId);
    if (!entry) {
      throw new ForbiddenException('No estas convocado a esta reunion');
    }

    if (entry.status !== AttendanceStatus.PRESENTE) {
      throw new ForbiddenException('Debes confirmar tu asistencia para entrar al chat de la reunion');
    }

    return meeting;
  }

  async listMeetingChatMessages(meetingId: string, userId: string, userRole: string, after?: string) {
    await this.ensureUserCanAccessMeetingChat(meetingId, userId, userRole);

    const afterDate = after ? new Date(after) : null;
    if (afterDate && Number.isNaN(afterDate.getTime())) {
      throw new BadRequestException('Parametro after invalido');
    }

    return prisma.chatMessage.findMany({
      where: { meetingId, ...(afterDate && { createdAt: { gt: afterDate } }) },
      include: {
        author: {
          select: { id: true, name: true, role: true, email: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async postMeetingChatMessage(meetingId: string, userId: string, userRole: string, dto: CreateChatMessageDto) {
    await this.ensureUserCanAccessMeetingChat(meetingId, userId, userRole);

    const content = dto.content.trim();
    if (!content) {
      throw new BadRequestException('El mensaje no puede estar vacio');
    }

    return prisma.$transaction(async (tx) => {
      // El estado se vuelve a leer con la fila bloqueada: si la reunion se esta cerrando o
      // cancelando en este instante, el mensaje espera y luego se rechaza.
      const locked = await this.lockMeeting(tx, meetingId, 'SHARE');
      if (this.isMeetingReadOnly(locked)) {
        throw new ForbiddenException('La reunion esta cancelada o finalizada; el chat es de solo lectura');
      }

      return tx.chatMessage.create({
        data: {
          meetingId,
          authorId: userId,
          content,
        },
        include: {
          author: {
            select: { id: true, name: true, role: true, email: true },
          },
        },
      });
    });
  }

  private mapPollResults(votes: Array<{ option: PollOption }>) {
    const total = votes.length;
    const aFavor = votes.filter((vote) => vote.option === PollOption.A_FAVOR).length;
    const enContra = votes.filter((vote) => vote.option === PollOption.EN_CONTRA).length;
    const abstencion = votes.filter((vote) => vote.option === PollOption.ABSTENCION).length;

    return {
      aFavor,
      abstencion,
      enContra,
      total,
    };
  }

  private readonly pollInclude = {
    createdBy: {
      select: { id: true, name: true, role: true, email: true },
    },
    votes: {
      include: {
        voter: {
          select: { id: true, name: true, role: true, email: true },
        },
      },
    },
  };

  private async getPollView(pollId: string) {
    const poll = await prisma.poll.findUniqueOrThrow({
      where: { id: pollId },
      include: this.pollInclude,
    });

    return {
      ...poll,
      results: this.mapPollResults(poll.votes),
    };
  }

  async listMeetingPolls(meetingId: string, userId: string, userRole: string) {
    await this.ensureUserCanAccessMeetingChat(meetingId, userId, userRole);

    const polls = await prisma.poll.findMany({
      where: { meetingId },
      include: this.pollInclude,
      orderBy: { createdAt: 'desc' },
    });

    return polls.map((poll) => ({
      ...poll,
      results: this.mapPollResults(poll.votes),
    }));
  }

  async createMeetingPoll(meetingId: string, userId: string, userRole: string, dto: CreatePollDto) {
    await this.ensureUserCanAccessMeetingChat(meetingId, userId, userRole);

    if (userRole !== Role.SECRETARIO && userRole !== Role.ADMIN) {
      throw new ForbiddenException('Solo secretaria o coordinacion pueden crear votaciones');
    }

    const poll = await prisma.$transaction(async (tx) => {
      const meeting = await this.lockMeeting(tx, meetingId, 'SHARE');

      if (meeting.isClosed || meeting.status !== Status.EN_CURSO) {
        throw new BadRequestException('Solo se pueden crear votaciones durante una reunion en curso');
      }

      if (!meeting.votingOpen) {
        throw new BadRequestException('La fase de votacion aun no ha sido iniciada');
      }

      if (!meeting.hasQuorum) {
        throw new BadRequestException('La reunion no tiene quorum; no se pueden abrir votaciones');
      }

      return tx.poll.create({
        data: {
          meetingId,
          createdById: userId,
          question: dto.question.trim(),
        },
        include: this.pollInclude,
      });
    });

    return {
      ...poll,
      results: this.mapPollResults(poll.votes),
    };
  }

  async voteMeetingPoll(
    meetingId: string,
    pollId: string,
    userId: string,
    userRole: string,
    dto: VotePollDto,
  ) {
    if (dto.option === PollOption.ABSTENCION) {
      throw new BadRequestException('El voto debe ser a favor o en contra');
    }

    const access = await this.ensureUserCanAccessMeetingChat(meetingId, userId, userRole);

    // Votan solo los convocados con asistencia presente.
    const entry = access.attendance.find((item) => item.userId === userId);
    if (!entry || entry.status !== AttendanceStatus.PRESENTE) {
      throw new ForbiddenException('Solo los participantes convocados con asistencia presente pueden votar');
    }

    await prisma.$transaction(async (tx) => {
      // Orden de bloqueo reunion -> votacion, el mismo que usa el cierre: el voto no puede
      // registrarse despues de que la votacion o la reunion se cierren.
      const meeting = await this.lockMeeting(tx, meetingId, 'SHARE');

      if (meeting.isClosed || meeting.status !== Status.EN_CURSO) {
        throw new BadRequestException('Solo se puede votar durante una reunion en curso');
      }

      if (!meeting.votingOpen) {
        throw new BadRequestException('La fase de votacion aun no ha sido iniciada');
      }

      const polls = await tx.$queryRaw<Array<{ status: PollStatus }>>`
        SELECT "status" FROM "Poll" WHERE "id" = ${pollId} AND "meetingId" = ${meetingId} FOR UPDATE`;

      if (polls.length === 0) {
        throw new NotFoundException('Votacion no encontrada para esta reunion');
      }

      if (polls[0].status === PollStatus.CLOSED) {
        throw new BadRequestException('La votacion ya fue cerrada');
      }

      await tx.pollVote.upsert({
        where: {
          pollId_voterId: {
            pollId,
            voterId: userId,
          },
        },
        update: {
          option: dto.option,
        },
        create: {
          pollId,
          voterId: userId,
          option: dto.option,
        },
      });
    });

    return this.getPollView(pollId);
  }

  async closeMeetingPoll(meetingId: string, pollId: string, userRole: string) {
    if (userRole !== Role.SECRETARIO && userRole !== Role.ADMIN) {
      throw new ForbiddenException('Solo secretaria o coordinacion pueden cerrar votaciones');
    }

    await prisma.$transaction(async (tx) => {
      const meeting = await this.lockMeeting(tx, meetingId, 'SHARE');
      if (meeting.isClosed) {
        throw new BadRequestException('La reunion ya fue finalizada');
      }

      const polls = await tx.$queryRaw<Array<{ status: PollStatus }>>`
        SELECT "status" FROM "Poll" WHERE "id" = ${pollId} AND "meetingId" = ${meetingId} FOR UPDATE`;

      if (polls.length === 0) {
        throw new NotFoundException('Votacion no encontrada para esta reunion');
      }

      if (polls[0].status !== PollStatus.CLOSED) {
        const presentAttendees = await tx.attendance.findMany({
          where: { meetingId, status: AttendanceStatus.PRESENTE },
          select: { userId: true },
        });
        const votes = await tx.pollVote.findMany({
          where: { pollId },
          select: { voterId: true },
        });
        const votedIds = new Set(votes.map((vote) => vote.voterId));
        const pending = presentAttendees.filter((att) => !votedIds.has(att.userId)).length;
        if (pending > 0) {
          throw new BadRequestException(
            `Todos los presentes deben votar antes de cerrar la votacion. Faltan ${pending} por votar.`,
          );
        }

        await tx.poll.update({
          where: { id: pollId },
          data: {
            status: PollStatus.CLOSED,
            closedAt: new Date(),
          },
        });
      }
    });

    return this.getPollView(pollId);
  }
}
