BEGIN;
ALTER TABLE "AbsenceAlert" ADD COLUMN IF NOT EXISTS "issuedAt" TIMESTAMP(3);
ALTER TABLE "AbsenceAlert" ADD COLUMN IF NOT EXISTS "issuedById" TEXT;
ALTER TABLE "AbsenceAlert" ADD COLUMN IF NOT EXISTS "evidence" JSONB;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AbsenceAlert_issuedById_fkey') THEN
    ALTER TABLE "AbsenceAlert" ADD CONSTRAINT "AbsenceAlert_issuedById_fkey"
      FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "AbsenceAlert_issuedAt_idx" ON "AbsenceAlert"("issuedAt");
COMMIT;