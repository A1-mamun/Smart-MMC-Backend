-- Add the per-course seat cap. NULL = uncapped (legacy behaviour);
-- DEFAULT 120 matches the operational direction ("120 for all courses").
-- Existing rows are backfilled to 120 so the new gate is non-blocking
-- for currently-running courses.

ALTER TABLE "courses"
  ADD COLUMN "totalSeats" INTEGER;

UPDATE "courses"
  SET "totalSeats" = 120
  WHERE "totalSeats" IS NULL;

ALTER TABLE "courses"
  ALTER COLUMN "totalSeats" SET DEFAULT 120;
