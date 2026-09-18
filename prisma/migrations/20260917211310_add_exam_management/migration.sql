-- CreateEnum
CREATE TYPE "ExamSectionType" AS ENUM ('MCQ', 'WRITTEN');

-- CreateTable
CREATE TABLE "exams" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "syllabus" TEXT NOT NULL,
    "examDate" DATE NOT NULL,
    "courseId" TEXT NOT NULL,
    "totalMarks" INTEGER NOT NULL,
    "isResultPublished" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_sections" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "type" "ExamSectionType" NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "totalQuestions" INTEGER NOT NULL,
    "marksPerQuestion" DECIMAL(6,2) NOT NULL,
    "totalMarks" INTEGER NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "exam_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_results" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "isAbsent" BOOLEAN NOT NULL DEFAULT false,
    "obtainedMarks" INTEGER NOT NULL DEFAULT 0,
    "rank" INTEGER,
    "remarks" VARCHAR(500),
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exam_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_result_sections" (
    "id" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "correctAnswers" INTEGER,
    "obtainedMarks" INTEGER NOT NULL DEFAULT 0,
    "notes" VARCHAR(300),

    CONSTRAINT "exam_result_sections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exams_courseId_idx" ON "exams"("courseId");

-- CreateIndex
CREATE INDEX "exams_examDate_idx" ON "exams"("examDate");

-- CreateIndex
CREATE INDEX "exams_isResultPublished_idx" ON "exams"("isResultPublished");

-- CreateIndex
CREATE INDEX "exam_sections_examId_idx" ON "exam_sections"("examId");

-- CreateIndex
CREATE UNIQUE INDEX "exam_sections_examId_name_key" ON "exam_sections"("examId", "name");

-- CreateIndex
CREATE INDEX "exam_results_examId_idx" ON "exam_results"("examId");

-- CreateIndex
CREATE INDEX "exam_results_studentId_idx" ON "exam_results"("studentId");

-- CreateIndex
CREATE INDEX "exam_results_obtainedMarks_idx" ON "exam_results"("obtainedMarks");

-- CreateIndex
CREATE UNIQUE INDEX "exam_results_examId_studentId_key" ON "exam_results"("examId", "studentId");

-- CreateIndex
CREATE INDEX "exam_result_sections_resultId_idx" ON "exam_result_sections"("resultId");

-- CreateIndex
CREATE INDEX "exam_result_sections_sectionId_idx" ON "exam_result_sections"("sectionId");

-- CreateIndex
CREATE UNIQUE INDEX "exam_result_sections_resultId_sectionId_key" ON "exam_result_sections"("resultId", "sectionId");

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_sections" ADD CONSTRAINT "exam_sections_examId_fkey" FOREIGN KEY ("examId") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_examId_fkey" FOREIGN KEY ("examId") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_result_sections" ADD CONSTRAINT "exam_result_sections_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "exam_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_result_sections" ADD CONSTRAINT "exam_result_sections_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "exam_sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
