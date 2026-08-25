-- Convert columns to text BEFORE dropping the enum.
ALTER TABLE "student_batches"
  ALTER COLUMN "batchTime" TYPE TEXT USING "batchTime"::TEXT;

ALTER TABLE "course_batch_groups"
  ALTER COLUMN "times" DROP DEFAULT;
ALTER TABLE "course_batch_groups"
  ALTER COLUMN "times" TYPE TEXT[] USING "times"::TEXT[];
ALTER TABLE "course_batch_groups"
  ALTER COLUMN "times" SET DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "courses" DROP COLUMN IF EXISTS "availableTimes";

DROP TYPE IF EXISTS "BatchTime" CASCADE;
