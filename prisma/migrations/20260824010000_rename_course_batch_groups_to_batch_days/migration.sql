-- Drop the existing course_batch_groups table (we're redesigning it as batch_days).
DROP TABLE IF EXISTS "course_batch_groups";

-- Create the new batch_days table mirroring the new BatchDay model.
CREATE TABLE "batch_days" (
    "id"        TEXT NOT NULL,
    "courseId"  TEXT NOT NULL,
    "label"     TEXT,
    "day"       TEXT NOT NULL,
    "times"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "position"  INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "batch_days_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "batch_days_courseId_idx" ON "batch_days"("courseId");

-- Drop the old availableDays column from courses (it was a denormalized copy of the enum array).
ALTER TABLE "courses" DROP COLUMN IF EXISTS "availableDays";

-- Convert StudentBatch.batchDay from BatchDay enum to text.
ALTER TABLE "student_batches"
  ALTER COLUMN "batchDay" TYPE TEXT USING "batchDay"::TEXT;

-- Drop the BatchDay enum (no longer referenced).
DROP TYPE IF EXISTS "BatchDay" CASCADE;
