import { MeetingCategory, MeetingMode, MeetingType } from '../../../generated/prisma';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class BaseAgendaPointDto {
  @IsString()
  @MinLength(4)
  @MaxLength(120)
  title: string;

  @IsString()
  @MinLength(10)
  @MaxLength(1500)
  description: string;
}

export class CreateMeetingDto {
  @IsString()
  @MinLength(4)
  @MaxLength(140)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsDateString()
  date: string;

  @IsEnum(MeetingType)
  meetingType: MeetingType;

  @IsEnum(MeetingCategory)
  meetingCategory: MeetingCategory;

  @IsEnum(MeetingMode)
  modality: MeetingMode;

  @IsString()
  @MinLength(3)
  @MaxLength(300)
  location: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  invitedUserIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => BaseAgendaPointDto)
  baseAgendaPoints?: BaseAgendaPointDto[];
}
