import { AttendanceStatus } from '../../../generated/prisma';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class MarkAttendanceDto {
  @IsEnum(AttendanceStatus)
  status: AttendanceStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  excuse?: string;
}
