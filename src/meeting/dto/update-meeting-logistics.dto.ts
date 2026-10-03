import { MeetingCategory, MeetingMode, MeetingType, Status } from '../../../generated/prisma';
import { IsDateString, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateMeetingLogisticsDto {
  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(140)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsDateString()
  date?: string;

  @IsOptional()
  @IsEnum(MeetingType)
  meetingType?: MeetingType;

  @IsOptional()
  @IsEnum(MeetingCategory)
  meetingCategory?: MeetingCategory;

  @IsOptional()
  @IsEnum(MeetingMode)
  modality?: MeetingMode;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  location?: string;

  @IsOptional()
  @IsEnum(Status)
  status?: Status;
}
