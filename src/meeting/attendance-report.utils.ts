import { BadRequestException } from '@nestjs/common';
import { AttendanceStatus, Prisma, Status } from '../../generated/prisma';
import { escapeHtml, letterheadHtml } from './pdf.utils';

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
const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const STATUS_LABELS: Record<string, string> = { PRESENTE: 'Presente', AUSENTE: 'Inasistencia injustificada', JUSTIFICADA: 'Inasistencia justificada' };
const CATEGORY_LABELS: Record<string, string> = { CONSEJO_CARRERA: 'Consejo Operativo', CID_PEDAGOGICO: 'Consejo Pedagógico', ASAMBLEA: 'Asamblea' };

type MonthlyReport = {
  year: number;
  month: number;
  meetingsCount: number;
  teachers: Array<ReturnType<typeof attendanceTotals> & {
    teacher: { name: string; cedula: string | null; isActive: boolean };
    records: Array<{ status: AttendanceStatus; excuse: string | null; meeting: { title: string; date: Date; meetingCategory: string } }>;
  }>;
};

export const monthName = (month: number) => MONTHS[month - 1];

const formatDate = (value: Date) => value.toLocaleString('es-VE', { dateStyle: 'full', timeStyle: 'short', timeZone: 'America/Caracas' });
const formatPercentage = (value: number | null) => value == null ? 'Sin datos' : `${value.toLocaleString('es-VE', { maximumFractionDigits: 2 })} %`;
const count = (value: number, singular: string, plural: string) => `${value} ${value === 1 ? singular : plural}`;
const isAtRisk = (row: MonthlyReport['teachers'][number]) => row.absent >= 3 || (row.percentage != null && row.percentage < 75);

export function buildMonthlyReportHtml(report: MonthlyReport, issuedAt = new Date()): string {
  const period = `${monthName(report.month)} ${report.year}`;
  const totals = report.teachers.reduce((acc, row) => ({ present: acc.present + row.present, absent: acc.absent + row.absent, justified: acc.justified + row.justified }), { present: 0, absent: 0, justified: 0 });
  const evaluated = totals.present + totals.absent + totals.justified;
  const teacherName = (row: MonthlyReport['teachers'][number]) => `${escapeHtml(row.teacher.name)}${row.teacher.isActive ? '' : ' <small>(inactivo)</small>'}`;
  const summaryRows = report.teachers.map((row) => `
    <tr class="${isAtRisk(row) ? 'risk' : ''}">
      <td>${teacherName(row)}</td>
      <td>${escapeHtml(row.teacher.cedula || '—')}</td>
      <td class="num">${row.present}</td>
      <td class="num">${row.absent}</td>
      <td class="num">${row.justified}</td>
      <td class="num">${row.total}</td>
      <td class="num"><strong>${formatPercentage(row.percentage)}</strong></td>
    </tr>`).join('');
  const details = report.teachers.filter((row) => row.records.length).map((row) => `
    <section class="teacher">
      <h3>${teacherName(row)} <span>${count(row.present, 'asistencia', 'asistencias')} · ${count(row.absent, 'injustificada', 'injustificadas')} · ${count(row.justified, 'justificada', 'justificadas')} · ${formatPercentage(row.percentage)}</span></h3>
      <table>
        <thead><tr><th>Fecha</th><th>Reunión</th><th>Estado</th><th>Justificativo</th></tr></thead>
        <tbody>${row.records.map((record) => `
          <tr>
            <td>${escapeHtml(formatDate(new Date(record.meeting.date)))}</td>
            <td>${escapeHtml(record.meeting.title)}<small>${escapeHtml(CATEGORY_LABELS[record.meeting.meetingCategory] || '')}</small></td>
            <td><span class="badge badge--${record.status.toLowerCase()}">${STATUS_LABELS[record.status] || record.status}</span></td>
            <td>${escapeHtml(record.excuse || '—')}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </section>`).join('');

  return `<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <title>Asistencia docente ${escapeHtml(period)}</title>
    <style>
      body { font-family: Georgia, "Times New Roman", serif; margin: 0; color: #172033; background: #fff; font-size: 12px; }
      h1 { margin: 0 0 4px; font-size: 22px; }
      h2 { font-size: 16px; margin: 22px 0 8px; }
      .head p { margin: 2px 0; color: #44506b; }
      .cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 14px 0; }
      .card { border: 1px solid #dbe4fa; border-radius: 8px; padding: 8px 10px; background: #f8fbff; }
      .card span { display: block; font-size: 10px; text-transform: uppercase; color: #61708d; }
      .card strong { font-size: 18px; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border: 1px solid #dbe4fa; padding: 5px 7px; text-align: left; vertical-align: top; }
      th { background: #f3f7ff; color: #233253; }
      thead { display: table-header-group; }
      tr { page-break-inside: avoid; }
      td small { display: block; color: #61708d; }
      .num { text-align: right; white-space: nowrap; }
      .risk td { background: #fef2f2; color: #991b1b; }
      .legend { color: #61708d; font-size: 10px; margin-top: 4px; }
      .teacher { page-break-inside: avoid; margin-top: 14px; }
      .teacher h3 { font-size: 13px; margin: 0 0 6px; }
      .teacher h3 span { font-weight: normal; color: #44506b; font-size: 11px; }
      .badge { display: inline-block; border-radius: 999px; padding: 1px 7px; font-size: 10px; font-weight: 700; white-space: nowrap; }
      .badge--presente { background: #ecfdf5; color: #065f46; }
      .badge--ausente { background: #fef2f2; color: #991b1b; }
      .badge--justificada { background: #fffbeb; color: #92400e; }
      .notice { border: 1px solid #dbe4fa; border-radius: 8px; padding: 10px; color: #44506b; }
    </style>
  </head>
  <body>
    ${letterheadHtml()}
    <div class="head">
      <h1>Reporte de asistencia docente — ${escapeHtml(period)}</h1>
      <p>Reuniones con asistencia consolidada en el período: <strong>${report.meetingsCount}</strong></p>
      <p>Emitido el ${escapeHtml(formatDate(issuedAt))}</p>
    </div>
    ${report.meetingsCount === 0 ? '<p class="notice">No hay reuniones con asistencia consolidada en este período.</p>' : `
    <div class="cards">
      <div class="card"><span>Asistencias</span><strong>${totals.present}</strong></div>
      <div class="card"><span>Injustificadas</span><strong>${totals.absent}</strong></div>
      <div class="card"><span>Justificadas</span><strong>${totals.justified}</strong></div>
      <div class="card"><span>Asistencia general</span><strong>${formatPercentage(evaluated ? Math.round(totals.present / evaluated * 10000) / 100 : null)}</strong></div>
    </div>
    <h2>Resumen por docente</h2>
    <table>
      <thead><tr><th>Docente</th><th>Cédula</th><th>Asistencias</th><th>Injustificadas</th><th>Justificadas</th><th>Total</th><th>% asistencia</th></tr></thead>
      <tbody>${summaryRows}</tbody>
    </table>
    <p class="legend">En rojo: docentes con asistencia menor al 75 % o con 3 o más inasistencias injustificadas en el mes. Las inasistencias justificadas cuentan en el total pero no como asistencia.</p>
    <h2>Detalle de asistencias e inasistencias por docente</h2>
    ${details}`}
  </body>
</html>`;
}
