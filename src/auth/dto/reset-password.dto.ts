import { IsString, Matches, MinLength, ValidateBy } from 'class-validator';

export class ResetPasswordDto {
  @IsString({ message: 'El enlace no es valido o ha caducado.' })
  @Matches(/^[A-Za-z0-9_-]{43}$/, {
    message: 'El enlace no es valido o ha caducado.',
  })
  token!: string;

  @IsString({ message: 'La contrasena debe ser texto.' })
  @MinLength(6, { message: 'La contrasena debe tener al menos 6 caracteres.' })
  @ValidateBy({
    name: 'maxPasswordBytes',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 72,
      defaultMessage: () => 'La contrasena no puede superar 72 bytes UTF-8.',
    },
  })
  password!: string;
}