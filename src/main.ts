import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { join } from 'path';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  try {
    const app = await NestFactory.create<NestExpressApplication>(AppModule);
    app.useGlobalFilters(new AllExceptionsFilter());

    app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads' });

    const configuredOrigins = process.env.CORS_ORIGINS?.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);

    app.enableCors({
      origin: configuredOrigins && configuredOrigins.length > 0 ? configuredOrigins : true,
      methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization'],
    });

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        exceptionFactory: (errors) => {
          const details = errors.map((error) => ({
            field: error.property,
            constraints: error.constraints,
          }));

          return new BadRequestException({
            message: 'Error de validacion',
            errorCode: 'VALIDATION_ERROR',
            details,
          });
        },
      }),
    );

    const swaggerConfig = new DocumentBuilder()
      .setTitle('API Actas UPT')
      .setDescription('Gestion de reuniones, agenda, asistencia, chat, votaciones y actas')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));

    const port = process.env.PORT ?? 5000;
    await app.listen(port);
    console.log(`Servidor iniciado en http://localhost:${port} (documentacion en /docs)`);
  } catch (error) {
    console.error('Error al iniciar el backend:', error);
    process.exit(1);
  }
}
bootstrap();
