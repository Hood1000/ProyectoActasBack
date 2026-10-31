import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength } from 'class-validator';

export class ForgotPasswordDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: 'El correo debe ser texto.' })
  @IsEmail({}, { message: 'Introduce un correo valido.' })
  @MaxLength(254, { message: 'El correo es demasiado largo.' })
  email!: string;
}