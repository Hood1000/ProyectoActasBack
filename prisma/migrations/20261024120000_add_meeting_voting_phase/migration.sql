-- Fase de votacion explicita: secretaria o coordinacion la inician durante la reunion.

-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN IF NOT EXISTS "votingOpen" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Meeting" ADD COLUMN IF NOT EXISTS "votingStartedAt" TIMESTAMP(3);
ALTER TABLE "Meeting" ADD COLUMN IF NOT EXISTS "votingStartedById" TEXT;
