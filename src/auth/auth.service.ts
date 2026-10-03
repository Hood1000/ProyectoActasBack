import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserService } from '../user/user.service';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class AuthService {
  constructor(private userService: UserService, private jwtService: JwtService) {}

  async validateUser(email: string, pass: string) {
    const user = await this.userService.findByEmail(email);
    if (user && !user.isActive) {
      throw new UnauthorizedException('Usuario deshabilitado');
    }

    if (user && await bcrypt.compare(pass, user.password)) {
      const { password, ...result } = user;
      return result;
    }
    return null;
  }

  async login(user: any) {
    const payload = { email: user.email, sub: user.id, role: user.role };
    return {
      access_token: this.jwtService.sign(payload),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        cedula: user.cedula || null,
        pnf: user.pnf || null,
        periodoAcademico: user.periodoAcademico || null,
        tramo: user.tramo || null,
        sede: user.sede || null,
        phoneNumber: user.phoneNumber || null,
        dedicacion: user.dedicacion || null,
        condicion: user.condicion || null,
        escalafon: user.escalafon || null,
        isActive: user.isActive ?? true,
      },
    };
  }

  async getSessionUser(userId: string) {
    const user = await this.userService.findById(userId);

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Usuario deshabilitado');
    }

    return user;
  }

  async register(data: any) {
    const hashedPassword = await bcrypt.hash(data.password, 10);

    const {
      condicion,
      dedicacion,
      email,
      pnf,
      role,
      sede,
      tramo,
    } = data;

    return this.userService.create({
      condicion,
      dedicacion,
      email,
      name: 'POR COMPLETAR',
      password: hashedPassword,
      pnf,
      role: role || 'DOCENTE',
      sede,
      tramo,
    });
  }
}
