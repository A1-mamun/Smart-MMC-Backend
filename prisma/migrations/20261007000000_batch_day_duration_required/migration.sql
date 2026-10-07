-- Make BatchDay.durationMinutes NOT NULL with a 60-minute default.
--
-- Why: the column was originally added nullable (see
-- 20261005214811_batch_day_duration) so existing seeded rows
-- could keep falling back to a 60-min default at the kiosk.
-- The frontend form is now required (create schema + RHF
-- defaults + mount-effect sync), so every fresh course ships
-- with an explicit value. Locking the column to NOT NULL is
-- the database-level guarantee that no future code path —
-- backfill, raw SQL, an admin who skips the validation layer
-- — can land another NULL row.
--
-- The migration runs in three steps so it works against both
-- empty and populated databases:
--
--   1. Backfill: any existing NULL durationMinutes is set to
--      60 (the legacy kiosk default). Doing this BEFORE adding
--      the NOT NULL constraint avoids the "violates not-null
--      constraint" error Postgres would otherwise raise.
--
--   2. Default: add `@default(60)` so future INSERTs that
--      omit the column (legacy code paths, raw SQL, seed
--      scripts) still land on a sensible value. Matches the
--      Prisma schema.
--
--   3. NOT NULL: flip the column to NOT NULL. After this
--      point any attempt to write a NULL fails at the
--      database layer, even if the application layer's
--      validation is bypassed.

-- Step 1 — backfill any existing NULL rows to the legacy default.
UPDATE "batch_days"
  SET "durationMinutes" = 60
  WHERE "durationMinutes" IS NULL;

-- Step 2 — add the default constraint.
ALTER TABLE "batch_days"
  ALTER COLUMN "durationMinutes" SET DEFAULT 60;

-- Step 3 — flip the column to NOT NULL.
ALTER TABLE "batch_days"
  ALTER COLUMN "durationMinutes" SET NOT NULL;
