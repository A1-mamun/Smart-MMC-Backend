-- Settings: generic single-row-per-key config table used by the
-- absent-warning control panel. Backed by `Setting` Prisma model.
CREATE TABLE "settings" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "updatedBy" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "settings_key_key" ON "settings"("key");
CREATE INDEX "settings_updatedBy_idx" ON "settings"("updatedBy");

ALTER TABLE "settings"
  ADD CONSTRAINT "settings_updatedBy_fkey"
  FOREIGN KEY ("updatedBy") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- WeeklyAbsentWarning: dedupe ledger for the absent-warning feature.
-- Unique on (studentId, isoYear, isoWeek) — guarantees one warning per
-- student per ISO week, matching the "max one time in a week" rule.
CREATE TABLE "weekly_absent_warnings" (
  "id" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "isoYear" INTEGER NOT NULL,
  "isoWeek" INTEGER NOT NULL,
  "absentDate" DATE NOT NULL,
  "sentToMobile" TEXT NOT NULL,
  "smsLogId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "weekly_absent_warnings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "weekly_absent_warnings_studentId_isoYear_isoWeek_key"
  ON "weekly_absent_warnings"("studentId", "isoYear", "isoWeek");
CREATE INDEX "weekly_absent_warnings_isoYear_isoWeek_idx"
  ON "weekly_absent_warnings"("isoYear", "isoWeek");
CREATE INDEX "weekly_absent_warnings_absentDate_idx"
  ON "weekly_absent_warnings"("absentDate");
CREATE INDEX "weekly_absent_warnings_smsLogId_idx"
  ON "weekly_absent_warnings"("smsLogId");

ALTER TABLE "weekly_absent_warnings"
  ADD CONSTRAINT "weekly_absent_warnings_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "students"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "weekly_absent_warnings"
  ADD CONSTRAINT "weekly_absent_warnings_smsLogId_fkey"
  FOREIGN KEY ("smsLogId") REFERENCES "sms_logs"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
