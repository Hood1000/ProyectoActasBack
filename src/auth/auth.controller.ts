import { Controller, Post, Body, Request, UnauthorizedException, UseGuards, HttpCode, ValidationPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { Roles } from './roles.decorator';
import { RolesGuard } from './roles.guard';
import { PasswordRecoveryService } from './password-recovery.service';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { RecoveryRateLimitGuard } from './recovery-rate-limit.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private readonly passwordRecoveryService: PasswordRecoveryService,
  ) {}

  @Post('forgot-password')
  @HttpCode(200)
  @UseGuards(RecoveryRateLimitGuard)
  forgotPassword(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    body: ForgotPasswordDto,
  ) {
    return this.passwordRecoveryService.forgotPassword(body.email);
  }

  @Post('reset-password')
  @HttpCode(200)
  @UseGuards(RecoveryRateLimitGuard)
  resetPassword(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    body: ResetPasswordDto,
  ) {
    return this.passwordRecoveryService.resetPassword(body.token, body.password);
  }

  @Post('login')
  async login(@Body() body: { email: string; password: string }) {
    const user = await this.authService.validateUser(body.email, body.password);
    if (!user) throw new UnauthorizedException('Credenciales inválidas');
    return this.authService.login(user);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @Post('register')
  async register(
    @Body()
    body: {
      email: string;
      password: string;
      role?: string;
      condicion?: string;
      dedicacion?: string;
      pnf?: string;
      sede?: string;
      tramo?: string;
    },
  ) {
    return this.authService.register(body);
  }

  @UseGuards(JwtAuthGuard)
  @Post('validate')
  validate(@Request() req: any) {
    return this.authService.getSessionUser(req.user.id);
  }
}
