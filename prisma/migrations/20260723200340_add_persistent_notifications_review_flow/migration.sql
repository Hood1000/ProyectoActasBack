-- CreateEnum
CREATE TYPE "AbsenceAlertReviewStatus" AS ENUM ('PENDIENTE', 'REVISADA', 'DESCARTADA');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('ABSENCE_ALERT');

-- AlterTable
ALTER TABLE "AbsenceAlert" ADD COLUMN     "reviewNotes" TEXT,
ADD COLUMN     "reviewStatus" "AbsenceAlertReviewStatus" NOT NULL DEFAULT 'PENDIENTE',
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT;

-- CreateTable
CREATE TABLE "SystemNotification" (
    "id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "actionHref" TEXT,
    "absenceAlertId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationRecipient" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SystemNotification_type_createdAt_idx" ON "SystemNotification"("type", "createdAt");

-- CreateIndex
CREATE INDEX "SystemNotification_absenceAlertId_idx" ON "SystemNotification"("absenceAlertId");

-- CreateIndex
CREATE INDEX "NotificationRecipient_userId_readAt_idx" ON "NotificationRecipient"("userId", "readAt");

-- CreateIndex
CREATE INDEX "NotificationRecipient_userId_dismissedAt_idx" ON "NotificationRecipient"("userId", "dismissedAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationRecipient_notificationId_userId_key" ON "NotificationRecipient"("notificationId", "userId");

-- CreateIndex
CREATE INDEX "AbsenceAlert_teacherId_academicYear_idx" ON "AbsenceAlert"("teacherId", "academicYear");

-- CreateIndex
CREATE INDEX "AbsenceAlert_notifiedAt_idx" ON "AbsenceAlert"("notifiedAt");

-- CreateIndex
CREATE INDEX "AbsenceAlert_reviewStatus_notifiedAt_idx" ON "AbsenceAlert"("reviewStatus", "notifiedAt");

-- CreateIndex
CREATE INDEX "ActionItem_meetingId_idx" ON "ActionItem"("meetingId");

-- CreateIndex
CREATE INDEX "ActionItem_responsibleId_idx" ON "ActionItem"("responsibleId");

-- CreateIndex
CREATE INDEX "AgendaPoint_meetingId_status_idx" ON "AgendaPoint"("meetingId", "status");

-- CreateIndex
CREATE INDEX "AgendaPoint_proposerId_meetingId_idx" ON "AgendaPoint"("proposerId", "meetingId");

-- CreateIndex
CREATE INDEX "Attendance_meetingId_status_idx" ON "Attendance"("meetingId", "status");

-- CreateIndex
CREATE INDEX "Attendance_userId_status_idx" ON "Attendance"("userId", "status");

-- CreateIndex
CREATE INDEX "ChatMessage_meetingId_createdAt_idx" ON "ChatMessage"("meetingId", "createdAt");

-- CreateIndex
CREATE INDEX "Meeting_status_date_idx" ON "Meeting"("status", "date");

-- CreateIndex
CREATE INDEX "Poll_meetingId_createdAt_idx" ON "Poll"("meetingId", "createdAt");

-- AddForeignKey
ALTER TABLE "AbsenceAlert" ADD CONSTRAINT "AbsenceAlert_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemNotification" ADD CONSTRAINT "SystemNotification_absenceAlertId_fkey" FOREIGN KEY ("absenceAlertId") REFERENCES "AbsenceAlert"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationRecipient" ADD CONSTRAINT "NotificationRecipient_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "SystemNotification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationRecipient" ADD CONSTRAINT "NotificationRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
