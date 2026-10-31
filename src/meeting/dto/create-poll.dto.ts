import { IsNotEmpty, IsString } from 'class-validator';

export class CreatePollDto {
  // Punto aprobado del orden del dia que se somete a votacion; la pregunta se genera a partir de el.
  @IsString()
  @IsNotEmpty()
  agendaPointId!: string;
}
