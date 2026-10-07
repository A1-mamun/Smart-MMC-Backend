-- Per-slot "admit enabled" flag on BatchDay.
--
-- Why: the admin needs to manually control which slot of a batch
-- accepts attendance at any given time. Each BatchDay has multiple
-- `times[]` slots (e.g. "SAT-MON-WED" might have "3:00 PM" and
-- "4:30 PM" on the same day). The kiosk should only accept scans
-- for the slot the admin has flagged as ON.
--
-- Design: a parallel Boolean[] array. `slotStates[i]` is true when
-- the i-th slot in `times[]` is accepting attendance. The
-- invariant is that exactly one slot is ON at any time (enforced
-- in the service layer on every read and every update).
--
-- Backward compat: existing rows have `slotStates = []`. The
-- service-layer read path treats `length(times) > slotStates.length`
-- as "all ON" (default for legacy rows), so existing seeded
-- batches continue to accept scans until the admin toggles a slot.
ALTER TABLE "batch_days"
  ADD COLUMN "slotStates" BOOLEAN[] NOT NULL DEFAULT '{}';