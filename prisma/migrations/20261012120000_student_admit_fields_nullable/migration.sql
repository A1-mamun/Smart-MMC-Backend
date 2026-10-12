-- Make previously-required Student profile fields optional.
--
-- The admit-student form was relaxed so the admission desk can
-- take walk-ins / students with incomplete profiles (missing
-- guardian info, no SSC certificate on hand, etc.) and back-fill
-- later from the student detail page. The Zod validation layer
-- was updated to make these optional, but the underlying
-- database columns were still NOT NULL, so Prisma rejected the
-- `tx.student.create({ data: { fatherName: null, ... } })` call.
--
-- Affected columns (all on the `students` table):
--   "fatherName", "fatherOccupation", "fatherMobile",
--   "addressUpozila", "addressDistrict", "sscInstitute"
--
-- Pre-existing data: every existing row has a non-null value for
-- each of these (the form required them before today), so this
-- migration just relaxes the NOT NULL constraint without touching
-- the data. No backfill is needed.
--
-- Note: the free-class signup path (see `intakeMode` column
-- comment) historically used placeholder strings ("FREE-pending" /
-- "00000000000") for these NOT NULL columns. With the columns now
-- nullable, future free-class rows can store `null` instead of
-- placeholders, but the existing placeholder rows are left alone
-- for now — backfilling them to NULL is a separate cleanup.
ALTER TABLE "students"
  ALTER COLUMN "fatherName" DROP NOT NULL,
  ALTER COLUMN "fatherOccupation" DROP NOT NULL,
  ALTER COLUMN "fatherMobile" DROP NOT NULL,
  ALTER COLUMN "addressUpozila" DROP NOT NULL,
  ALTER COLUMN "addressDistrict" DROP NOT NULL,
  ALTER COLUMN "sscInstitute" DROP NOT NULL;
