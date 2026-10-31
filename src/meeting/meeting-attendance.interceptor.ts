import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map } from 'rxjs/operators';

export function scopeMeetingAttendance(value: unknown, user: { id: string; role: string }): unknown {
  if (user.role === 'ADMIN') return value;
  if (Array.isArray(value)) return value.map((item) => scopeMeetingAttendance(item, user));
  if (!value || typeof value !== 'object') return value;
  const meeting = value as Record<string, unknown>;
  if (!Array.isArray(meeting.attendance)) return value;
  const historical = meeting.isClosed || ['FINALIZADA', 'CANCELADA'].includes(String(meeting.status));
  return {
    ...meeting,
    attendance: historical ? [] : user.role === 'SECRETARIO' ? meeting.attendance : meeting.attendance.filter((entry: { userId: string }) => entry.userId === user.id),
  };
}

@Injectable()
export class MeetingAttendancePrivacyInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<{ user: { id: string; role: string } }>();
    return next.handle().pipe(map((value: unknown) => scopeMeetingAttendance(value, request.user)));
  }
}