-- Drop the legacy `Course.isActive` boolean.
--
-- Lifecycle is now expressed through `Course.status` alone
-- (ADMISSION / ONGOING / COMPLETE). All callers that previously
-- filtered on `isActive = true` now rely on `status != COMPLETE`
-- (see the matching `status: { not: 'COMPLETE' }` clauses in the
-- service layer). This migration is purely destructive — it drops
-- the column and its single-column index. No data is migrated
-- because the column is fully derived from `status`.

-- DropIndex
DROP INDEX IF EXISTS "courses_isActive_idx";

-- DropColumn
ALTER TABLE "courses" DROP COLUMN IF EXISTS "isActive";
