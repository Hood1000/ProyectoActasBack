import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreatePollDto {
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  question!: string;
}
