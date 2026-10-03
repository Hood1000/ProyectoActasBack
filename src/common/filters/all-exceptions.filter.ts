import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

type ErrorBody = {
  statusCode: number;
  message: string;
  errorCode: string;
  path: string;
  method: string;
  timestamp: string;
  details?: unknown;
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    const { statusCode, message, errorCode, details } = this.mapException(exception);

    const body: ErrorBody = {
      statusCode,
      message,
      errorCode,
      path: request.url,
      method: request.method,
      timestamp: new Date().toISOString(),
      details,
    };

    if (statusCode >= 500) {
      this.logger.error(`${request.method} ${request.url} -> ${statusCode} ${message}`, exception as Error);
    } else {
      this.logger.warn(`${request.method} ${request.url} -> ${statusCode} ${message}`);
    }

    response.status(statusCode).json(body);
  }

  private mapException(exception: unknown): {
    statusCode: number;
    message: string;
    errorCode: string;
    details?: unknown;
  } {
    if (this.isPrismaKnownRequestError(exception)) {
      return this.mapPrismaKnownError(exception);
    }

    if (this.isPrismaValidationError(exception)) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Solicitud invalida para base de datos',
        errorCode: 'PRISMA_VALIDATION_ERROR',
        details: String(exception),
      };
    }

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const response = exception.getResponse();

      if (typeof response === 'string') {
        return {
          statusCode,
          message: response,
          errorCode: 'HTTP_EXCEPTION',
        };
      }

      const asObject = response as Record<string, unknown>;
      const msg = asObject.message;
      const details = Array.isArray(msg) ? msg : asObject;
      const readableMessage = Array.isArray(msg)
        ? 'Error de validacion'
        : (msg as string) || exception.message;

      return {
        statusCode,
        message: readableMessage,
        errorCode: (asObject.error as string) || 'HTTP_EXCEPTION',
        details,
      };
    }

    const unknown = exception as Error;
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Error interno del servidor',
      errorCode: 'INTERNAL_SERVER_ERROR',
      details: unknown?.message || 'Unexpected failure',
    };
  }

  private mapPrismaKnownError(exception: { code: string; meta?: unknown }): {
    statusCode: number;
    message: string;
    errorCode: string;
    details?: unknown;
  } {
    switch (exception.code) {
      case 'P2002':
        return {
          statusCode: HttpStatus.CONFLICT,
          message: 'Registro duplicado, ya existe un valor unico',
          errorCode: 'PRISMA_UNIQUE_CONSTRAINT',
          details: exception.meta,
        };
      case 'P2003':
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'No se puede completar la operacion por relacion invalida',
          errorCode: 'PRISMA_FOREIGN_KEY_CONSTRAINT',
          details: exception.meta,
        };
      case 'P2025':
        return {
          statusCode: HttpStatus.NOT_FOUND,
          message: 'El recurso solicitado no existe',
          errorCode: 'PRISMA_RECORD_NOT_FOUND',
          details: exception.meta,
        };
      default:
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'Error de base de datos',
          errorCode: `PRISMA_${exception.code}`,
          details: exception.meta,
        };
    }
  }

  private isPrismaKnownRequestError(exception: unknown): exception is { code: string; meta?: unknown } {
    return (
      typeof exception === 'object' &&
      exception !== null &&
      'code' in exception &&
      'clientVersion' in exception
    );
  }

  private isPrismaValidationError(exception: unknown): boolean {
    return (
      typeof exception === 'object' &&
      exception !== null &&
      'name' in exception &&
      (exception as { name: string }).name === 'PrismaClientValidationError'
    );
  }
}
