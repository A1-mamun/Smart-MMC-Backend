-- Drop make-up / swap attendance support.
--
-- Make-up attendance is no longer supported — students can only attend
-- their own enrolled slot. Scans on a day the student isn't enrolled
-- in are rejected with a 400 by the check-in service. This migration:
--
--   1. Rewrites any pre-existing SWAP rows to PRESENT so the column is
--      safe to narrow. Shouldn't be any after the application rolls
--      out the no-swap code paths, but written defensively so the
--      migration is idempotent against partially-applied states.
--   2. Drops the `swapFromDate` column and its index.
--   3. Recreates the AttendanceStatus enum without the SWAP value.
--
-- Postgres can't ALTER TYPE ... DROP VALUE (the operation isn't
-- supported to avoid breaking existing rows referencing the value).
-- The standard workaround is:
--   a) Create a new enum with only the values we want.
--   b) ALTER the column to use the new type.
--   c) Drop the old type.
--   e) Rename the new type to the original name.
-- We do this in a transaction so the column is never in an inconsistent
-- state visible to other connections.

BEGIN;

-- Step 1 — defensively rewrite any SWAP rows to PRESENT. SWAP only
-- ever meant "this student scanned on a peer-batch day" — collapsing
-- it to PRESENT matches reality (the student did attend, just not on
-- their dedicated day). Once the no-swap application code lands, the
-- cron + check-in paths can no longer write SWAP, so this UPDATE is
-- expected to affect zero rows on a freshly-migrated database.
UPDATE "attendance"
  SET "status" = 'PRESENT'
  WHERE "status" = 'SWAP';

-- Step 2 — drop the swapFromDate column + the index. Order matters:
-- drop the index before the column so the planner doesn't see a
-- dangling index reference.
DROP INDEX IF EXISTS "attendance_swapFromDate_idx";
ALTER TABLE "attendance" DROP COLUMN IF EXISTS "swapFromDate";

-- Step 3 — recreate the enum without SWAP.
CREATE TYPE "AttendanceStatus_new" AS ENUM ('PRESENT', 'ABSENT');
ALTER TABLE "attendance"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "AttendanceStatus_new"
    USING "status"::text::"AttendanceStatus_new",
  ALTER COLUMN "status" SET DEFAULT 'PRESENT';
DROP TYPE "AttendanceStatus";
ALTER TYPE "AttendanceStatus_new" RENAME TO "AttendanceStatus";

COMMIT;