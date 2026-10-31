import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { UserModule } from '../user/user.module';
import { MailModule } from '../mail/mail.module';
import { SessionModule } from './session.module';
import { PasswordRecoveryService } from './password-recovery.service';
import { RecoveryRateLimitGuard } from './recovery-rate-limit.guard';

@Module({
  imports: [
    UserModule,
    MailModule,
    SessionModule,
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '1d' },
    }),
  ],
  providers: [AuthService, JwtStrategy, PasswordRecoveryService, RecoveryRateLimitGuard],
  controllers: [AuthController],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
