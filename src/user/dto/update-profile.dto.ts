import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MinLength(5)
  cedula?: string;

  @IsOptional()
  @IsString()
  @MinLength(7)
  phoneNumber?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  tramo?: string;

  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;
}
