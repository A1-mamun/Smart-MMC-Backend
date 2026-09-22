-- Add the swapFromDate column to Attendance. Nullable so existing rows are
-- unaffected. Index for the (rare) admin query that filters "show me every
-- swapped row this week".
ALTER TABLE "attendance"
  ADD COLUMN "swapFromDate" DATE;

CREATE INDEX "attendance_swapFromDate_idx" ON "attendance" ("swapFromDate");
