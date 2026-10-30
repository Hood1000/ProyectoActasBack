import { AgendaStatus } from '../../../generated/prisma';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class ReviewAgendaPointDto {
  @IsEnum(AgendaStatus)
  status: AgendaStatus;

  @IsOptional()
  @IsString()
  reviewComment?: string;
}
