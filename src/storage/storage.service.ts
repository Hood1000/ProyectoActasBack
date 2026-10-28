import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Storage } from '@google-cloud/storage';
import { createHmac, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import { dirname, join, resolve, sep } from 'path';

// Referencias que se guardan en la base de datos:
//   gs://<bucket>/<key>  -> objeto en Google Cloud Storage
//   /uploads/<key>       -> archivo en disco local (desarrollo y registros anteriores a GCS)
const GCS_PREFIX = 'gs://';
const LOCAL_PREFIX = '/uploads/';

export type SignedUrl = { url: string; expiresAt: string };

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly localRoot = resolve(process.cwd(), 'uploads');
  private readonly bucketName = process.env.GCS_BUCKET?.trim() || null;
  private readonly signedUrlTtlSeconds = Number(process.env.GCS_SIGNED_URL_TTL_SECONDS || 600);
  private storageClient: Storage | null = null;

  get driver(): 'gcs' | 'local' {
    return this.bucketName ? 'gcs' : 'local';
  }

  // Credenciales por ADC: GOOGLE_APPLICATION_CREDENTIALS o la identidad del servidor.
  private get gcs(): Storage {
    if (!this.storageClient) {
      this.storageClient = new Storage({ projectId: process.env.GCS_PROJECT_ID || undefined });
    }
    return this.storageClient;
  }

  async upload(buffer: Buffer, key: string, contentType: string): Promise<string> {
    if (this.bucketName) {
      await this.gcs
        .bucket(this.bucketName)
        .file(key)
        .save(buffer, {
          resumable: false,
          contentType,
          metadata: { cacheControl: 'private, max-age=0' },
        });
      return `${GCS_PREFIX}${this.bucketName}/${key}`;
    }

    const target = this.resolveLocalPath(key);
    await fs.promises.mkdir(dirname(target), { recursive: true });
    await fs.promises.writeFile(target, buffer);
    return `${LOCAL_PREFIX}${key}`;
  }

  async getSignedReadUrl(reference: string, baseUrl: string): Promise<SignedUrl> {
    const expires = Date.now() + this.signedUrlTtlSeconds * 1000;
    const expiresAt = new Date(expires).toISOString();

    const gcsObject = this.parseGcsReference(reference);
    if (gcsObject) {
      const [url] = await this.gcs
        .bucket(gcsObject.bucket)
        .file(gcsObject.key)
        .getSignedUrl({ version: 'v4', action: 'read', expires });
      return { url, expiresAt };
    }

    const key = this.parseLocalReference(reference);
    if (!fs.existsSync(this.resolveLocalPath(key))) {
      throw new NotFoundException('El archivo no existe');
    }
    const params = new URLSearchParams({ key, expires: String(expires), sig: this.signLocal(key, expires) });
    return { url: `${baseUrl}/storage/local?${params.toString()}`, expiresAt };
  }

  // Elimina sin propagar errores: se usa para limpiar el archivo reemplazado.
  async deleteQuietly(reference: string | null | undefined): Promise<void> {
    if (!reference) return;
    try {
      const gcsObject = this.parseGcsReference(reference);
      if (gcsObject) {
        await this.gcs.bucket(gcsObject.bucket).file(gcsObject.key).delete({ ignoreNotFound: true });
        return;
      }
      await fs.promises.rm(this.resolveLocalPath(this.parseLocalReference(reference)), { force: true });
    } catch (error) {
      this.logger.warn(`No se pudo eliminar ${reference}: ${(error as Error).message}`);
    }
  }

  // Valida la firma de una URL local y devuelve la ruta absoluta del archivo.
  resolveSignedLocalFile(key: string, expires: number, sig: string): string {
    const expected = Buffer.from(this.signLocal(key, expires));
    const received = Buffer.from(sig || '');
    const validSignature = expected.length === received.length && timingSafeEqual(expected, received);

    if (!validSignature || !Number.isFinite(expires) || Date.now() > expires) {
      throw new NotFoundException('Enlace invalido o vencido');
    }

    const target = this.resolveLocalPath(key);
    if (!fs.existsSync(target)) {
      throw new NotFoundException('El archivo no existe');
    }
    return target;
  }

  private signLocal(key: string, expires: number): string {
    const secret = process.env.JWT_SECRET || '';
    return createHmac('sha256', secret).update(`${key}:${expires}`).digest('hex');
  }

  private parseGcsReference(reference: string): { bucket: string; key: string } | null {
    if (!reference.startsWith(GCS_PREFIX)) return null;
    const path = reference.slice(GCS_PREFIX.length);
    const slash = path.indexOf('/');
    if (slash <= 0) return null;
    return { bucket: path.slice(0, slash), key: path.slice(slash + 1) };
  }

  private parseLocalReference(reference: string): string {
    if (!reference.startsWith(LOCAL_PREFIX)) {
      throw new NotFoundException('Referencia de archivo no reconocida');
    }
    return reference.slice(LOCAL_PREFIX.length);
  }

  // Evita que una clave con "../" salga de la carpeta uploads.
  private resolveLocalPath(key: string): string {
    const target = resolve(join(this.localRoot, key));
    if (!target.startsWith(this.localRoot + sep)) {
      throw new NotFoundException('Ruta de archivo invalida');
    }
    return target;
  }
}
