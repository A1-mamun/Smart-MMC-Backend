-- AlterTable
ALTER TABLE "courses" ADD COLUMN     "availableDays" "BatchDay"[] DEFAULT ARRAY[]::"BatchDay"[],
ADD COLUMN     "availableTimes" "BatchTime"[] DEFAULT ARRAY[]::"BatchTime"[],
ADD COLUMN     "hscBatch" "HscBatch" NOT NULL DEFAULT 'BATCH_27';

-- CreateIndex
CREATE INDEX "courses_hscBatch_idx" ON "courses"("hscBatch");
