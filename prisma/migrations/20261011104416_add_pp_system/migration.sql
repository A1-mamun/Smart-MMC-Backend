-- CreateEnum
CREATE TYPE "PpPaymentMethod" AS ENUM ('CASH', 'BKASH', 'NAGAD', 'BANK', 'OTHER');

-- AlterTable
ALTER TABLE "students" ADD COLUMN     "ppFee" DECIMAL(10,2),
ADD COLUMN     "ppId" TEXT;

-- CreateTable
CREATE TABLE "pps" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "createdById" TEXT NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pp_payments" (
    "id" TEXT NOT NULL,
    "ppId" TEXT NOT NULL,
    "studentId" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "method" "PpPaymentMethod" NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidBy" TEXT NOT NULL,
    "note" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pp_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pps_isDeleted_idx" ON "pps"("isDeleted");

-- CreateIndex
CREATE INDEX "pps_name_idx" ON "pps"("name");

-- CreateIndex
CREATE INDEX "pp_payments_ppId_idx" ON "pp_payments"("ppId");

-- CreateIndex
CREATE INDEX "pp_payments_studentId_idx" ON "pp_payments"("studentId");

-- CreateIndex
CREATE INDEX "pp_payments_paidAt_idx" ON "pp_payments"("paidAt");

-- CreateIndex
CREATE INDEX "students_ppId_idx" ON "students"("ppId");

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_ppId_fkey" FOREIGN KEY ("ppId") REFERENCES "pps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pps" ADD CONSTRAINT "pps_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pp_payments" ADD CONSTRAINT "pp_payments_ppId_fkey" FOREIGN KEY ("ppId") REFERENCES "pps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pp_payments" ADD CONSTRAINT "pp_payments_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pp_payments" ADD CONSTRAINT "pp_payments_paidBy_fkey" FOREIGN KEY ("paidBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
