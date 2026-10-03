/*
  Warnings:

  - You are about to drop the column `present` on the `Attendance` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PENDIENTE', 'PRESENTE', 'AUSENTE', 'JUSTIFICADA');

-- AlterTable
ALTER TABLE "Attendance" DROP COLUMN "present",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "excuse" TEXT,
ADD COLUMN     "markedAt" TIMESTAMP(3),
ADD COLUMN     "status" "AttendanceStatus" NOT NULL DEFAULT 'PENDIENTE';

-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN     "attendanceClosesAt" TIMESTAMP(3),
ADD COLUMN     "attendanceFinalized" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "attendanceFinalizedAt" TIMESTAMP(3),
ADD COLUMN     "attendanceOpensAt" TIMESTAMP(3);
