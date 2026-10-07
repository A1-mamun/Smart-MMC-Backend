-- Add per-batch class duration (in minutes) to BatchDay.
--
-- Why: the kiosk attendance window needs to know the class duration
-- to show a live progress bar / countdown. Previously the backend
-- hard-coded 60 minutes; with this column each batch can be its
-- own length (e.g. 1h15m for a SAT-MON-WED batch, 2h for a
-- lab session, etc.). Nullable so existing rows fall back to the
-- legacy 60-min default until the admin sets an explicit value.
ALTER TABLE "batch_days"
  ADD COLUMN "durationMinutes" INTEGER;