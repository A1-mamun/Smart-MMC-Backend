-- Revert BatchDay.slotStates from `String[]` back to `Boolean[]`.
--
-- The previous migration introduced a tri-state design ("true" /
-- "false" / "") to support a planned auto-by-time cycle. The
-- product decision has reverted: the field is now strictly the
-- "barcode scan allowed right now" flag, with no auto behavior.
-- The admin manually turns a slot ON at class start and OFF at
-- class end. Converting back to `Boolean[]` keeps the kiosk
-- logic trivial and matches the explicit data shape.
--
-- Each existing `String` element is mapped back to a Boolean:
--   - "true"  → true
--   - "false" → false
--   - ""      → false (treat the absent-value "no override" as
--                effectively OFF now that auto-cycle is gone).
--
-- The cross-course "only one ON" invariant is enforced in the
-- service layer (see `toggleBatchSlotToDB`) on every toggle —
-- it doesn't depend on this column's storage shape.

-- 1. Drop the existing default so the type change doesn't trip
--    on "default for column cannot be cast automatically".
ALTER TABLE "batch_days" ALTER COLUMN "slotStates" DROP DEFAULT;

-- 2. Convert each row's String[] → Boolean[] via a function
--    (USING subqueries aren't allowed in transform expressions).
CREATE OR REPLACE FUNCTION migrate_slot_states_to_boolean() RETURNS void AS $$
DECLARE
  bd record;
  arr_str text[];
  arr_bool bool[];
  v text;
  b bool;
  i int;
BEGIN
  FOR bd IN SELECT id, "slotStates" FROM "batch_days" LOOP
    arr_str := bd."slotStates";
    arr_bool := ARRAY[]::bool[];
    IF arr_str IS NOT NULL THEN
      FOR i IN 1..array_length(arr_str, 1) LOOP
        v := arr_str[i];
        IF v = 'true' THEN
          b := true;
        ELSE
          b := false;
        END IF;
        arr_bool := array_append(arr_bool, b);
      END LOOP;
    END IF;
    UPDATE "batch_days" SET "slotStates" = arr_bool WHERE id = bd.id;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

SELECT migrate_slot_states_to_boolean();

-- 3. Now switch the column type. The USING expression must be
--    typed correctly: we re-use the function output (already
--    bool[]), but Postgres still needs an explicit USING.
ALTER TABLE "batch_days" ALTER COLUMN "slotStates" TYPE BOOLEAN[]
  USING "slotStates"::bool[];

DROP FUNCTION migrate_slot_states_to_boolean();

-- 4. Restore the empty-array default for fresh rows.
ALTER TABLE "batch_days" ALTER COLUMN "slotStates" SET DEFAULT '{}';