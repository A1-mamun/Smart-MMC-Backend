-- Hot path for the per-slot seat-cap gate inside
-- resolveBatchDayForCourse (`studentBatch.count({ batchDayId, batchTime })`)
-- and the GET /course/:id/seats aggregation. Adding the compound index
-- up-front keeps both queries fast as enrollment grows.

CREATE INDEX IF NOT EXISTS "student_batches_batchDayId_batchTime_idx"
  ON "student_batches" ("batchDayId", "batchTime");
