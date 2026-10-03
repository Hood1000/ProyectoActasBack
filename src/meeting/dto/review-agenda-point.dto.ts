import { AgendaStatus } from '../../../generated/prisma';
import { IsEnum } from 'class-validator';

export class ReviewAgendaPointDto {
  @IsEnum(AgendaStatus)
  status: AgendaStatus;
}
