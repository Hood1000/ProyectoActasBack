import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AttendanceStatus, Prisma } from '../../generated/prisma';
import prisma from '../prismaClient';
import { AttendanceReportQueryDto, IssueWarningDto } from './dto/attendance-report.dto';
import { attendanceScope, attendanceTotals } from './attendance-report.utils';

const teacherSelect = { id: true, name: true, cedula: true, isActive: true } as const;
const warningSelect = {
  id: true, teacherId: true, academicYear: true, absencesCount: true, summary: true,
  issuedAt: true, evidence: true, teacher: { select: teacherSelect },
  issuedBy: { select: { id: true, name: true } },
} as const;
const absenceSelect = {
  id: true, userId: true, status: true, excuse: true,
  meeting: { select: { id: true, title: true, date: true, meetingCategory: true } },
} as const;

@Injectable()
export class AttendanceReportService {
  async summary(query: AttendanceReportQueryDto) {
    const scope = attendanceScope(query.year, query.month);
    const where: Prisma.UserWhereInput = {
      role: 'DOCENTE',
      ...(query.search?.trim() ? { OR: [
        { name: { contains: query.search.trim(), mode: 'insensitive' } },
        { cedula: { contains: query.search.trim() } },
      ] } : {}),
    };
    const [total, teachers] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({ where, select: teacherSelect, orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: (query.page - 1) * query.limit, take: query.limit }),
    ]);
    const groups = await prisma.attendance.groupBy({
      by: ['userId', 'status'], where: { ...scope, userId: { in: teachers.map((teacher) => teacher.id) } }, _count: { _all: true },
    });
    return { items: teachers.map((teacher) => ({ teacher, ...attendanceTotals(groups.filter((group) => group.userId === teacher.id)) })), total, page: query.page, limit: query.limit };
  }

  async history(teacherId: string, query: AttendanceReportQueryDto) {
    const where = { ...attendanceScope(query.year, query.month), userId: teacherId };
    const teacher = await prisma.user.findFirst({ where: { id: teacherId, role: 'DOCENTE' }, select: teacherSelect });
    if (!teacher) throw new NotFoundException('Docente no encontrado');
    const [groups, items] = await Promise.all([
      prisma.attendance.groupBy({ by: ['status'], where, _count: { _all: true } }),
      prisma.attendance.findMany({ where, select: absenceSelect, orderBy: [{ meeting: { date: 'desc' } }, { id: 'asc' }], skip: (query.page - 1) * query.limit, take: query.limit }),
    ]);
    const totals = attendanceTotals(groups);
    return { teacher, ...totals, items, page: query.page, limit: query.limit };
  }

  private absenceWhere(year: number): Prisma.AttendanceWhereInput {
    return { ...attendanceScope(year), status: AttendanceStatus.AUSENTE, OR: [{ excuse: null }, { excuse: '' }] };
  }

  async cases(query: AttendanceReportQueryDto) {
    const year = query.year || Number(new Date().toLocaleString('en-US', { timeZone: 'America/Caracas', year: 'numeric' }));
    if (query.month) throw new BadRequestException('Los casos se acumulan por ano, no por mes');
    const where = this.absenceWhere(year);
    const grouped = await prisma.attendance.groupBy({
      by: ['userId'], where, _count: { _all: true }, having: { userId: { _count: { gte: 3 } } }, orderBy: { userId: 'asc' },
    });
    const selected = grouped.slice((query.page - 1) * query.limit, query.page * query.limit);
    const ids = selected.map((group) => group.userId);
    const [teachers, absences, warnings] = await Promise.all([
      prisma.user.findMany({ where: { id: { in: ids } }, select: teacherSelect }),
      prisma.attendance.findMany({ where: { ...where, userId: { in: ids } }, select: absenceSelect, orderBy: { meeting: { date: 'asc' } } }),
      prisma.absenceAlert.findMany({ where: { teacherId: { in: ids }, academicYear: year, issuedAt: { not: null } }, select: warningSelect }),
    ]);
    return { year, total: grouped.length, page: query.page, limit: query.limit, items: selected.map((group) => ({
      teacher: teachers.find((teacher) => teacher.id === group.userId),
      absencesCount: group._count._all,
      absences: absences.filter((absence) => absence.userId === group.userId),
      warning: warnings.find((warning) => warning.teacherId === group.userId) || null,
    })) };
  }

  async warnings(query: AttendanceReportQueryDto, user: { id: string; role: string }) {
    if (query.month) throw new BadRequestException('Filtra las amonestaciones por ano');
    const where: Prisma.AbsenceAlertWhereInput = {
      issuedAt: { not: null }, ...(query.year ? { academicYear: query.year } : {}),
      ...(user.role === 'DOCENTE' ? { teacherId: user.id } : {}),
    };
    const [total, items] = await Promise.all([
      prisma.absenceAlert.count({ where }),
      prisma.absenceAlert.findMany({ where, select: warningSelect, orderBy: [{ issuedAt: 'desc' }, { id: 'asc' }], skip: (query.page - 1) * query.limit, take: query.limit }),
    ]);
    return { items, total, page: query.page, limit: query.limit };
  }

  async warning(id: string, user: { id: string; role: string }) {
    const warning = await prisma.absenceAlert.findFirst({ where: { id, issuedAt: { not: null } }, select: warningSelect });
    if (!warning) throw new NotFoundException('Amonestacion no encontrada');
    if (user.role === 'DOCENTE' && warning.teacherId !== user.id) throw new ForbiddenException('No puedes consultar amonestaciones de otro docente');
    return warning;
  }

  async issue(teacherId: string, issuerId: string, dto: IssueWarningDto) {
    const content = dto.content.trim();
    if (content.length < 20) throw new BadRequestException('Describe el motivo y la accion realizada (minimo 20 caracteres)');
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await prisma.$transaction(async (tx) => {
          const teacher = await tx.user.findFirst({ where: { id: teacherId, role: 'DOCENTE' }, select: teacherSelect });
          const issuer = await tx.user.findFirst({ where: { id: issuerId, role: 'SECRETARIO', isActive: true }, select: { id: true, name: true } });
          const existing = await tx.absenceAlert.findUnique({ where: { teacherId_academicYear_threshold: { teacherId, academicYear: dto.year, threshold: 3 } } });
          const absences = await tx.attendance.findMany({ where: { ...this.absenceWhere(dto.year), userId: teacherId }, select: absenceSelect, orderBy: { meeting: { date: 'asc' } } });
          if (!issuer) throw new ForbiddenException('Solo Secretaria puede emitir una amonestacion');
          if (!teacher) throw new NotFoundException('Docente no encontrado');
          if (existing?.issuedAt) throw new ConflictException('Este caso ya tiene una amonestacion emitida');
          if (absences.length < 3) throw new BadRequestException('El docente no acumula 3 inasistencias injustificadas en ese ano');
          const now = new Date();
          const evidence = {
            teacher, issuer, year: dto.year, threshold: 3,
            absences: absences.map((absence) => ({ attendanceId: absence.id, meetingId: absence.meeting.id, title: absence.meeting.title, date: absence.meeting.date.toISOString() })),
          };
          const data = {
            summary: content, teacherId, academicYear: dto.year, threshold: 3,
            absencesCount: absences.length, meetingId: absences[absences.length - 1].meeting.id,
            issuedAt: now, issuedById: issuerId, evidence,
            reviewStatus: 'REVISADA' as const, reviewedAt: now, reviewedById: issuerId,
          };
          return existing
            ? tx.absenceAlert.update({ where: { id: existing.id }, data, select: warningSelect })
            : tx.absenceAlert.create({ data, select: warningSelect });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          if (error.code === 'P2034' && attempt < 2) continue;
          if (error.code === 'P2002' || error.code === 'P2034') throw new ConflictException('El caso cambio o ya fue emitido. Actualiza la lista');
        }
        throw error;
      }
    }
    throw new ConflictException('No se pudo emitir la amonestacion. Actualiza la lista');
  }
}