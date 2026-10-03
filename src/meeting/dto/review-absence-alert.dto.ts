import { AbsenceAlertReviewStatus } from '../../../generated/prisma';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class ReviewAbsenceAlertDto {
  @IsEnum(AbsenceAlertReviewStatus)
  status!: AbsenceAlertReviewStatus;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reviewNotes?: string;
}