-- CreateTable
CREATE TABLE "AbsenceAlert" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "meetingId" TEXT,
    "academicYear" INTEGER NOT NULL,
    "threshold" INTEGER NOT NULL DEFAULT 3,
    "absencesCount" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "notifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbsenceAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AbsenceAlert_teacherId_academicYear_threshold_key" ON "AbsenceAlert"("teacherId", "academicYear", "threshold");

-- AddForeignKey
ALTER TABLE "AbsenceAlert" ADD CONSTRAINT "AbsenceAlert_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbsenceAlert" ADD CONSTRAINT "AbsenceAlert_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE SET NULL ON UPDATE CASCADE;
