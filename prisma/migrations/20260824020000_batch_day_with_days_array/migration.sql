-- Rename column `label` to `name` (rename, no data loss).
ALTER TABLE "batch_days" RENAME COLUMN "label" TO "name";

-- Drop the single `day` column and replace with `days` TEXT[].
-- First wrap each existing value in an array so we don't lose data.
ALTER TABLE "batch_days" ADD COLUMN "days" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Backfill `days` from `day` so existing rows keep their day information.
UPDATE "batch_days" SET "days" = ARRAY["day"]::TEXT[] WHERE "day" IS NOT NULL;

ALTER TABLE "batch_days" DROP COLUMN "day";
