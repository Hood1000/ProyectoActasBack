import { BadRequestException } from '@nestjs/common';
import { AttendanceStatus, Prisma, Status } from '../../generated/prisma';

export function attendanceScope(year?: number, month?: number, now = new Date()): Prisma.AttendanceWhereInput {
  if (month && !year) throw new BadRequestException('Selecciona un ano para filtrar por mes');
  const date: Prisma.DateTimeFilter = { lte: now };
  if (year) {
    date.gte = new Date(Date.UTC(year, month ? month - 1 : 0, 1, 4));
    date.lt = new Date(Date.UTC(month ? year : year + 1, month || 0, 1, 4));
  }
  return {
    user: { role: 'DOCENTE' },
    meeting: { attendanceFinalized: true, status: { not: Status.CANCELADA }, date },
    status: { in: [AttendanceStatus.PRESENTE, AttendanceStatus.AUSENTE, AttendanceStatus.JUSTIFICADA] },
  };
}

export function attendanceTotals(groups: Array<{ status: AttendanceStatus; _count: { _all: number } }>) {
  const totals = { present: 0, absent: 0, justified: 0, total: 0, percentage: null as number | null };
  for (const group of groups) {
    if (group.status === AttendanceStatus.PRESENTE) totals.present += group._count._all;
    if (group.status === AttendanceStatus.AUSENTE) totals.absent += group._count._all;
    if (group.status === AttendanceStatus.JUSTIFICADA) totals.justified += group._count._all;
  }
  totals.total = totals.present + totals.absent + totals.justified;
  if (totals.total) totals.percentage = Math.round(totals.present / totals.total * 10000) / 100;
  return totals;
}