-- Motivo del rechazo de una propuesta del orden del dia.
-- Idempotente: se puede aplicar con `prisma migrate deploy` o con `prisma db execute`.

-- AlterTable
ALTER TABLE "AgendaPoint" ADD COLUMN IF NOT EXISTS "reviewComment" TEXT;
