-- Create the PaymentStatus enum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PARTIAL', 'PAID');

-- Add the status column to student_courses
ALTER TABLE "student_courses" ADD COLUMN "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING';

-- Index for fast filtering by status
CREATE INDEX "student_courses_status_idx" ON "student_courses"("status");

-- Backfill existing rows: a student_course is PAID if all of its non-deleted
-- payments sum to >= the course fee, PARTIAL if any payment exists, else PENDING.
UPDATE "student_courses" sc
SET "status" = CASE
  WHEN COALESCE((
    SELECT SUM(p.amount) FROM "payments" p
    WHERE p."studentCourseId" = sc.id AND p."isDeleted" = false
  ), 0) >= (SELECT c.fee FROM "courses" c WHERE c.id = sc."courseId")
  THEN 'PAID'::"PaymentStatus"
  WHEN EXISTS (SELECT 1 FROM "payments" p WHERE p."studentCourseId" = sc.id AND p."isDeleted" = false)
  THEN 'PARTIAL'::"PaymentStatus"
  ELSE 'PENDING'::"PaymentStatus"
END
WHERE sc."isDeleted" = false;
