import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { StorageService } from './storage.service';

// Descarga de archivos locales con URL firmada (equivalente a la URL firmada de GCS
// cuando no hay bucket configurado). No requiere JWT: la firma HMAC y el vencimiento
// son la autorizacion, igual que en GCS.
@ApiExcludeController()
@Controller('storage')
export class StorageController {
  constructor(private readonly storageService: StorageService) {}

  @Get('local')
  download(
    @Query('key') key: string,
    @Query('expires') expires: string,
    @Query('sig') sig: string,
    @Res() res: Response,
  ) {
    const filePath = this.storageService.resolveSignedLocalFile(key, Number(expires), sig);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(filePath);
  }
}
