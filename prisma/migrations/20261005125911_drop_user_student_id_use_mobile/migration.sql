-- Drop `User.studentId` and make `User.mobile` the canonical login
-- identifier for ALL user types (students, admins, super admins).
--
-- Why drop `User.studentId`?
--   - It was brittle across multi-course admits. A student admitted
--     to HSC_1ST_YEAR then HSC_2ND_YEAR would either collide with the
--     next roll number (the old `generateStudentId` was searching
--     users by `studentId` prefix and could pick a roll that already
--     belonged to a different user) or get a stale global ID baked
--     into User.studentId. The per-enrollment
--     `StudentCourse.studentCourseId` is the correct scope for the
--     printable handle shown on receipts.
--   - Admins had a parallel `SMC-ADMIN-NNN` identifier that added
--     operational overhead and required separate login paths. With
--     mobile as the single handle, sign-in is uniform across roles.
--
-- Pre-flight (verified before writing this migration):
--   SELECT id, role, mobile FROM users WHERE mobile IS NULL;
--   → 0 rows. Safe to apply NOT NULL.
--
-- Postgres treats NULL values as distinct in a UNIQUE index, so the
-- `users_mobile_key` index (already present from
-- 20260921220000_mobile_unique) is reusable when we drop the
-- nullability.
--
-- Backwards compatibility note: any external system that authenticated
-- against `User.studentId` (the old `SMC-ADMIN-001` super admin
-- credential, the per-student printable handle, etc.) needs to be
-- retargeted at `User.mobile`. The frontend's sign-in payload is
-- updated to use `mobile` instead of `studentId` (see
-- authApi.ts / authSlice.ts). The receipt / StudentsTable display
-- surfaces `StudentCourse.studentCourseId` (the per-enrollment
-- handle) instead.

-- ─── Make User.mobile non-null ───────────────────────────────────────────
ALTER TABLE "users" ALTER COLUMN "mobile" SET NOT NULL;

-- ─── Drop the legacy studentId column + its index ──────────────────────
DROP INDEX IF EXISTS "users_studentId_idx";
ALTER TABLE "users" DROP COLUMN "studentId";