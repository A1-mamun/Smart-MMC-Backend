-- Course lifecycle: replace the boolean `isCompleted` flag with a
-- proper three-stage enum + a separate enrollment-gate boolean.
--
-- Why split into two fields?
--   - `status` (CourseStatus enum: ADMISSION / ONGOING / COMPLETE) is
--     descriptive — drives the Courses page badge color, the admit-form
--     course picker visibility, etc.
--   - `isAllowAdmitAnotherCourse` is the actual enrollment gate. When
--     true, a student with an active enrollment in THIS course is
--     allowed to admit into another course. Defaults to false.
--
-- Why keep them as two fields rather than deriving one from the other?
--   - An admin might want to mark a course COMPLETE without immediately
--     opening the floodgates for re-admission (e.g. an end-of-cycle
--     ceremony before next batch). Conversely, a course can stay
--     ADMISSION but temporarily allow re-admission if the admin wants
--     to clean up stragglers.
--   - The status-set endpoint keeps them CONSISTENT by default
--     (COMPLETE → flag on, anything else → flag off) so admins can't
--     accidentally drift them apart via single-click transitions. The
--     flag stays independently queryable for the few cases that need it.
--
-- Backfill strategy:
--   - Existing `isCompleted = true`  →  status = COMPLETE AND
--                                       isAllowAdmitAnotherCourse = true
--   - Existing `isCompleted = false` →  status = ADMISSION AND
--                                       isAllowAdmitAnotherCourse = false
--
-- `completedAt` / `completedBy` columns are kept (still useful for the
-- COMPLETE audit trail — when + who flipped the batch to graduated).
-- They're cleared on any future non-COMPLETE status transition.

-- ─── New enum ────────────────────────────────────────────────────────────
CREATE TYPE "CourseStatus" AS ENUM ('ADMISSION', 'ONGOING', 'COMPLETE');

-- ─── Schema changes ──────────────────────────────────────────────────────
ALTER TABLE "courses"
  ADD COLUMN "status" "CourseStatus" NOT NULL DEFAULT 'ADMISSION',
  ADD COLUMN "isAllowAdmitAnotherCourse" BOOLEAN NOT NULL DEFAULT false;

-- ─── Backfill ────────────────────────────────────────────────────────────
-- isCompleted = true rows → graduated: flag the gate on so the existing
-- "students can move to a new course once their batch is done" contract
-- stays in force. isCompleted = false rows stay ADMISSION / closed gate.
UPDATE "courses"
SET
  "status" = CASE WHEN "isCompleted" THEN 'COMPLETE'::"CourseStatus" ELSE 'ADMISSION'::"CourseStatus" END,
  "isAllowAdmitAnotherCourse" = "isCompleted";

-- ─── Drop legacy column + index ──────────────────────────────────────────
DROP INDEX IF EXISTS "courses_isCompleted_idx";
ALTER TABLE "courses" DROP COLUMN "isCompleted";

-- ─── New index on the status enum (replaces the dropped one) ────────────
CREATE INDEX "courses_status_idx" ON "courses" ("status");