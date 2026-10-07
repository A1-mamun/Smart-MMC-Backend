-- Change BatchDay.slotStates from `Boolean[]` to `String[]`.
--
-- Why: the previous `Boolean[]` could only carry `true` / `false`
-- values, but the new design needs a tri-state per element:
--   - "true"  → admin forced this slot ON (override time)
--   - "false" → admin forced this slot OFF (override time)
--   - (absent) → no manual override; kiosk auto-cycles by time
--
-- Postgres's `Boolean[]` doesn't support per-element null, and
-- Prisma's typed-array syntax doesn't support nullable elements
-- either, so we switch to a `String[]` column where each
-- element is one of "true" / "false" / "" (empty for absent).
-- The backend parses each element on read; see
-- `parseSlotOverride` / `formatSlotOverride` in course.service.ts.
--
-- Backwards compat: existing rows had `Boolean[]` arrays like
-- `[true, false]`. We convert each `true` to "true" and each
-- `false` to "false" so any explicit admin override is preserved.
-- New rows default to `[]` (length matches `times[]` after
-- `normaliseSlotStates` pads), which the kiosk treats as
-- "no manual override" → auto-cycle by time.

ALTER TABLE "batch_days" ALTER COLUMN "slotStates" DROP NOT NULL;
ALTER TABLE "batch_days" ALTER COLUMN "slotStates" SET DEFAULT '{}';
ALTER TABLE "batch_days" ALTER COLUMN "slotStates" TYPE TEXT[] USING array[]::text[];

-- Convert each element: true → "true", false → "false". Run
-- via a function because Postgres can't do conditional element
-- transforms in a single UPDATE.
CREATE OR REPLACE FUNCTION migrate_slot_states() RETURNS void AS $$
DECLARE
  bd record;
  arr_len int;
  v bool;
  s text;
BEGIN
  FOR bd IN SELECT id, "slotStates", array_length("slotStates", 1) AS len FROM "batch_days" LOOP
    arr_len := bd.len;
    IF arr_len IS NULL OR arr_len = 0 THEN
      -- Already an empty array, or NULL — leave as-is (the
      -- kiosk treats both as "no manual override").
      CONTINUE;
    END IF;
    -- Convert each bool → "true" / "false".
    FOR i IN 1..arr_len LOOP
      v := bd."slotStates"[i];
      IF v IS TRUE THEN
        s := 'true';
      ELSIF v IS FALSE THEN
        s := 'false';
      ELSE
        s := '';
      END IF;
      UPDATE "batch_days"
        SET "slotStates" = array_append(
          CASE WHEN i = 1 THEN ARRAY[]::text[] ELSE "slotStates" END,
          s
        )
        WHERE id = bd.id;
    END LOOP;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

SELECT migrate_slot_states();
DROP FUNCTION migrate_slot_states();