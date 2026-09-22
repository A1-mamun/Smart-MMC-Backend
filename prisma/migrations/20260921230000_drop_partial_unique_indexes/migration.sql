-- Reconcile two pieces of pre-existing drift between the schema and DB:
--
-- 1. `student_courses.studentCourseId` — the schema declares
--    `String? @unique`, but the original migration
--    `20260921000000_user_mobile_and_student_course_id` only created a
--    PARTIAL unique `WHERE "studentCourseId" IS NOT NULL`. Functionally
--    the two are equivalent in Postgres (NULL values are never equal
--    under a unique index), but the partial form has a confusing
--    "filtered unique" name that misleads when comparing schema ↔ DB.
--    Replace with the full unique the schema asks for.
--
-- 2. `users_mobile_active_unique` — same situation. Added by earlier
--    work as a partial unique `WHERE (mobile IS NOT NULL AND isDeleted = false)`
--    but the schema now declares `mobile String? @unique` (full unique,
--    NULLs coexist). The full unique is strictly more permissive — it
--    allows duplicate mobiles among soft-deleted users but still blocks
--    duplicate active ones. Drop the partial; the full one we already
--    added (users_mobile_key) covers the same enforcement.
--
-- Pre-flight (must return 0 rows before this migration can apply):
--   SELECT "studentCourseId", COUNT(*)
--     FROM "student_courses"
--    WHERE "studentCourseId" IS NOT NULL
--    GROUP BY "studentCourseId" HAVING COUNT(*) > 1;
--
--   SELECT mobile, COUNT(*)
--     FROM users
--    WHERE mobile IS NOT NULL AND "isDeleted" = false
--    GROUP BY mobile HAVING COUNT(*) > 1;
--
-- Both queries returned 0 rows on the live DB at the time of writing.

DROP INDEX "student_courses_studentCourseId_key";
CREATE UNIQUE INDEX "student_courses_studentCourseId_key"
  ON "student_courses"("studentCourseId");

DROP INDEX "users_mobile_active_unique";
