import { ArrayUnique, IsArray, IsUUID } from 'class-validator';

export class SetInviteesDto {
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  invitedUserIds: string[];
}
