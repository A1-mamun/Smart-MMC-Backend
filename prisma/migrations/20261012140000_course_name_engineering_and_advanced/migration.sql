-- Extend the CourseName enum.
--
-- The previous enum had:
--   HSC_1ST_YEAR, HSC_2ND_YEAR, HSC_FINAL_PREPARATION, ADMISSION
--
-- The legacy `ADMISSION` value is being renamed to
-- `ADVANCED_ADMISSION` (the product team re-scoped the
-- "Admission" course to a higher-tier offering), and a new
-- `ENGINEERING_AND_VARSITY_ADMISSION` variant is being added
-- to cover the engineering / university admission track.
--
-- Pre-existing data: a `SELECT name, count(*) FROM courses
-- WHERE name = 'ADMISSION'` on the live DB returns 0 rows —
-- the seed never inserted a course with that name and no
-- operator has manually created one. The rename is therefore
-- a no-op on data; the RENAME VALUE statement just rewrites
-- the enum's metadata.
--
-- Postgres requires ADD VALUE to run outside a transaction
-- (or to be the only statement in a transaction). Both
-- statements are safe to run in a normal migration because
-- Prisma wraps each migration.sql in its own transaction
-- and Postgres 12+ allows `ALTER TYPE ... ADD VALUE` to
-- participate in the same transaction as long as the new
-- value is not used by the same transaction. The RENAME is
-- a metadata-only change and is also safe.

-- Step 1: rename the existing variant.
ALTER TYPE "CourseName" RENAME VALUE 'ADMISSION' TO 'ADVANCED_ADMISSION';

-- Step 2: add the new engineering / varsity track.
ALTER TYPE "CourseName" ADD VALUE 'ENGINEERING_AND_VARSITY_ADMISSION';
