import { PollOption } from '../../../generated/prisma';
import { IsEnum } from 'class-validator';

export class VotePollDto {
  @IsEnum(PollOption)
  option!: PollOption;
}
