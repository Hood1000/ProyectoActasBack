-- Columnas de cancelacion de reuniones. Idempotente: algunas bases ya las tienen
-- porque se agregaron con `prisma db push` antes de versionar esta migracion.

-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN IF NOT EXISTS "cancellationReason" TEXT;
ALTER TABLE "Meeting" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3);
ALTER TABLE "Meeting" ADD COLUMN IF NOT EXISTS "cancelledById" TEXT;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Meeting_cancelledById_fkey'
  ) THEN
    ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_cancelledById_fkey"
      FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
