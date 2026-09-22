-- ExamAbsenceWarning: dedupe ledger for the exam-absence father-warning
-- feature. One row per (examId, studentId) blocks re-warns for the same
-- exam regardless of how many cron ticks pass after the delay threshold.
-- We do NOT scope by week — an examinee can only sit an exam once, so
-- (examId, studentId) is sufficient and the row is reusable across
-- academic years.
CREATE TABLE "exam_absence_warnings" (
  "id" TEXT NOT NULL,
  "examId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "absentDate" DATE NOT NULL,
  "warnedAt" DATE NOT NULL,
  "sentToMobile" TEXT NOT NULL,
  "smsLogId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "exam_absence_warnings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "exam_absence_warnings_examId_studentId_key"
  ON "exam_absence_warnings"("examId", "studentId");
CREATE INDEX "exam_absence_warnings_examId_idx"
  ON "exam_absence_warnings"("examId");
CREATE INDEX "exam_absence_warnings_studentId_idx"
  ON "exam_absence_warnings"("studentId");
CREATE INDEX "exam_absence_warnings_warnedAt_idx"
  ON "exam_absence_warnings"("warnedAt");
CREATE INDEX "exam_absence_warnings_smsLogId_idx"
  ON "exam_absence_warnings"("smsLogId");

ALTER TABLE "exam_absence_warnings"
  ADD CONSTRAINT "exam_absence_warnings_examId_fkey"
  FOREIGN KEY ("examId") REFERENCES "exams"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "exam_absence_warnings"
  ADD CONSTRAINT "exam_absence_warnings_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "students"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "exam_absence_warnings"
  ADD CONSTRAINT "exam_absence_warnings_smsLogId_fkey"
  FOREIGN KEY ("smsLogId") REFERENCES "sms_logs"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
