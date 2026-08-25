-- CreateTable
CREATE TABLE "course_batch_groups" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "label" TEXT,
    "days" "BatchDay"[],
    "times" "BatchTime"[],
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "course_batch_groups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "course_batch_groups_courseId_idx" ON "course_batch_groups"("courseId");

-- AddForeignKey
ALTER TABLE "course_batch_groups" ADD CONSTRAINT "course_batch_groups_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
