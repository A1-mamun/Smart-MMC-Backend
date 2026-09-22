-- Add Course.isCompleted (admin-set batch-graduation flag) plus the
-- actor/timestamp columns used by the activity log. Default false so
-- every existing row keeps its current behaviour: students enrolled in
-- those courses can still re-enroll in another course, exactly as
-- before.
ALTER TABLE "courses"
  ADD COLUMN "isCompleted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "completedBy" TEXT;

-- Backfill actor FK constraint.
ALTER TABLE "courses"
  ADD CONSTRAINT "courses_completedBy_fkey"
  FOREIGN KEY ("completedBy") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "courses_isCompleted_idx" ON "courses"("isCompleted");
