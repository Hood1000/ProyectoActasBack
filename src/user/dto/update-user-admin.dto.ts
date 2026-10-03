import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { Condicion, Dedicacion, Role } from '../../../generated/prisma';

export class UpdateUserAdminDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  pnf?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  sede?: string;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @IsOptional()
  @IsEnum(Dedicacion)
  dedicacion?: Dedicacion;

  @IsOptional()
  @IsEnum(Condicion)
  condicion?: Condicion;

}
