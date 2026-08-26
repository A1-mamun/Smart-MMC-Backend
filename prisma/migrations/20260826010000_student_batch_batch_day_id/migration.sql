-- Add the optional batchDayId FK to student_batches so we can filter students
-- by the specific BatchDay group (e.g. "Weekend" / "Weekday") they belong to.
ALTER TABLE "student_batches" ADD COLUMN "batchDayId" TEXT;

-- Add the foreign key constraint, with SetNull on delete so removing a
-- BatchDay doesn't cascade-delete a student's batch assignment.
ALTER TABLE "student_batches"
  ADD CONSTRAINT "student_batches_batchDayId_fkey"
  FOREIGN KEY ("batchDayId") REFERENCES "batch_days"("id") ON DELETE SET NULL;

CREATE INDEX "student_batches_batchDayId_idx" ON "student_batches"("batchDayId");
