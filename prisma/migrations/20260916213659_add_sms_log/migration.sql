-- CreateEnum
CREATE TYPE "SmsLogStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "SmsSendMode" AS ENUM ('ONE_TO_ONE', 'ONE_TO_MANY');

-- DropForeignKey
ALTER TABLE "student_batches" DROP CONSTRAINT "student_batches_batchDayId_fkey";

-- DropIndex
DROP INDEX "student_batches_batchDay_idx";

-- CreateTable
CREATE TABLE "sms_logs" (
    "id" TEXT NOT NULL,
    "recipients" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" "SmsLogStatus" NOT NULL DEFAULT 'PENDING',
    "upstreamCode" TEXT,
    "errorMsg" TEXT,
    "count" INTEGER NOT NULL DEFAULT 0,
    "mode" "SmsSendMode" NOT NULL,
    "sentById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sms_logs_sentById_idx" ON "sms_logs"("sentById");

-- CreateIndex
CREATE INDEX "sms_logs_status_idx" ON "sms_logs"("status");

-- CreateIndex
CREATE INDEX "sms_logs_createdAt_idx" ON "sms_logs"("createdAt");

-- AddForeignKey
ALTER TABLE "batch_days" ADD CONSTRAINT "batch_days_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_batches" ADD CONSTRAINT "student_batches_batchDayId_fkey" FOREIGN KEY ("batchDayId") REFERENCES "batch_days"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_logs" ADD CONSTRAINT "sms_logs_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
