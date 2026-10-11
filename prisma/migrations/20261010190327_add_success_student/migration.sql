-- CreateTable
CREATE TABLE "success_students" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "institute" VARCHAR(150) NOT NULL,
    "batch" VARCHAR(50) NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "success_students_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "success_students_createdAt_idx" ON "success_students"("createdAt");

-- AddForeignKey
ALTER TABLE "success_students" ADD CONSTRAINT "success_students_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
