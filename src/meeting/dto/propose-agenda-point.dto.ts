import { IsString, MaxLength, MinLength } from 'class-validator';

export class ProposeAgendaPointDto {
  @IsString()
  @MinLength(4)
  @MaxLength(120)
  title: string;

  @IsString()
  @MinLength(10)
  @MaxLength(1500)
  description: string;
}
