-- CreateEnum
CREATE TYPE "MeetingCategory" AS ENUM ('CONSEJO_CARRERA', 'CID_PEDAGOGICO', 'ASAMBLEA');

-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN     "meetingCategory" "MeetingCategory" NOT NULL DEFAULT 'CONSEJO_CARRERA';
