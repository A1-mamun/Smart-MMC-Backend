-- Add per-slot "check-in window override" flag on BatchDay.
--
-- The default check-in window opens at class start and closes 5
-- minutes after. The admin can override this window per-slot —
-- flip `manualWindowOverride[i]` to `true` to open the window
-- early (e.g. admit a parent who's early) or to keep it open
-- past the 5-minute mark (e.g. when the class is delayed).
-- When the override is `false` (or absent), the kiosk uses
-- the default 5-minute window centred on the slot start time.
--
-- Default value: empty array (no overrides). The kiosk
-- interprets absent / false as "use the default window".
ALTER TABLE "batch_days"
  ADD COLUMN "manualWindowOverride" BOOLEAN[] NOT NULL DEFAULT '{}';