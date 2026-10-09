-- Add the AttendanceStatus enum (PRESENT / ABSENT / SWAP) and the
-- Attendance.status column with a default of PRESENT, then backfill
-- every existing row to PRESENT (historical rows were all created at
-- check-in, so PRESENT is the only honest backfill — the cron absent
-- marker will set ABSENT explicitly for rows it inserts going forward).
--
-- The migration runs in five steps so it works against both empty and
-- populated databases and so Postgres never sees a NULL value in the
-- new NOT NULL column:
--
--   1. Create the enum type. Idempotent via IF NOT EXISTS-style guard:
--      Postgres doesn't have one for enums, so we use a DO block that
--      skips the CREATE TYPE if it's already there.
--
--   2. Add the `status` column as NULLABLE first so the ALTER TABLE
--      succeeds against a populated table without violating any existing
--      row (a NOT NULL column with a default is fine, but adding it
--      directly requires a full table rewrite on large tables; the
--      NULLABLE-then-backfill-then-NOT NULL pattern keeps it cheap).
--
--   3. Backfill every existing row to PRESENT.
--
--   4. Add the NOT NULL constraint plus the @default(PRESENT) so the
--      column matches the Prisma schema and future INSERTs without a
--      `status` value land on PRESENT.
--
--   5. Add the (date, status) composite index for the cron absent-
--      marking query — "all rows on this date grouped by status".

-- Step 1 — create the enum.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AttendanceStatus') THEN
    CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'SWAP');
  END IF;
END
$$;

-- Step 2 — add the column as nullable.
ALTER TABLE "attendance"
  ADD COLUMN "status" "AttendanceStatus";

-- Step 3 — backfill existing rows to PRESENT. Every historical row
-- was inserted by a check-in flow, so PRESENT is the truthful value.
UPDATE "attendance"
  SET "status" = 'PRESENT'
  WHERE "status" IS NULL;

-- Step 4 — flip to NOT NULL with default PRESENT. From this point on
-- the column matches the Prisma schema and the application can rely
-- on a non-null value.
ALTER TABLE "attendance"
  ALTER COLUMN "status" SET DEFAULT 'PRESENT',
  ALTER COLUMN "status" SET NOT NULL;

-- Step 5 — composite index for the cron's "rows on this date by status"
-- hot path. Postgres uses this for both the "who's already covered"
-- lookup (date = X) and the absent batch insert's idempotency check.
CREATE INDEX "attendance_date_status_idx" ON "attendance" ("date", "status");