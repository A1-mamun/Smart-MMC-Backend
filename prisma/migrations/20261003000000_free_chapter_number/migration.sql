-- Add chapterNumber to free_chapters and enforce uniqueness per subject.
-- chapterNumber is the admin-supplied 1-based ordinal (1, 2, 3…)
-- that drives both the accordion sort order and the picker identity.
-- Gaps are allowed (e.g. 1, 3, 7) so the admin can reserve future
-- slots without renumbering existing chapters.

-- 1. Add the nullable column.
ALTER TABLE "free_chapters" ADD COLUMN "chapterNumber" SMALLINT;

-- 2. Backfill from the existing `position` column. The two have
--    been kept in lockstep (position = chapterNumber) since the
--    free-class content tree was introduced, so a straight copy is
--    correct. The NULLIF guards the rare case where a chapter was
--    somehow created with a non-positive position — those would
--    otherwise be promoted to chapterNumber=0 which is invalid.
UPDATE "free_chapters"
  SET "chapterNumber" = NULLIF("position", 0)
  WHERE "position" > 0;

-- 3. Lock the column down.
ALTER TABLE "free_chapters" ALTER COLUMN "chapterNumber" SET NOT NULL;

-- 4. Enforce uniqueness per subject. The unique index also doubles
--    as the lookup index for the chapter picker.
CREATE UNIQUE INDEX "free_chapters_subjectId_chapterNumber_key"
  ON "free_chapters" ("subjectId", "chapterNumber");

-- 5. The old compound sort index is still useful for any
--    caller ordering by position (we keep it for back-compat with
--    the admin UI that already renders `position` in the chapter
--    list). Postgres will share the leaf pages with the unique
--    index above when both leading columns are equal.
--    (No action — the existing index stays.)