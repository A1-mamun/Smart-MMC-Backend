-- Free Classes feature: surface new lifecycle columns on users / students
-- and the public content tree (FreeSubject → FreeChapter → FreeTopic →
-- FreeContentView). Designed to support YouTube today and VdoCipher /
-- FILE providers later without a UI rewiring.

-- ─── Enums ─────────────────────────────────────────────────────────────────
CREATE TYPE "StudentIntakeMode" AS ENUM ('ONLINE', 'OFFLINE');

CREATE TYPE "FreeContentProvider" AS ENUM ('YOUTUBE', 'VDOCIPHER', 'FILE');

-- ─── User ─────────────────────────────────────────────────────────────────
ALTER TABLE "users"
  ADD COLUMN "isFreeAccount"    BOOLEAN            NOT NULL DEFAULT false,
  ADD COLUMN "freeSignupAt"    TIMESTAMP(3),
  ADD COLUMN "freeSignupSource" "StudentIntakeMode",
  ADD COLUMN "freeConvertedAt" TIMESTAMP(3);

CREATE INDEX "users_isFreeAccount_idx" ON "users" ("isFreeAccount");

-- ─── Student ──────────────────────────────────────────────────────────────
ALTER TABLE "students"
  ADD COLUMN "intakeMode"        "StudentIntakeMode" NOT NULL DEFAULT 'ONLINE',
  ADD COLUMN "isFreeAccount"     BOOLEAN              NOT NULL DEFAULT false,
  ADD COLUMN "freeSignupAt"      TIMESTAMP(3),
  ADD COLUMN "freeConvertedAt"   TIMESTAMP(3),
  ADD COLUMN "freeHscBatch"      "HscBatch",
  ADD COLUMN "freeDistrict"      TEXT,
  ADD COLUMN "freeUpazila"       TEXT;

CREATE INDEX "students_isFreeAccount_idx" ON "students" ("isFreeAccount");
CREATE INDEX "students_intakeMode_idx"    ON "students" ("intakeMode");

-- ─── Free content tree ────────────────────────────────────────────────────
CREATE TABLE "free_subjects" (
  "id"         TEXT NOT NULL,
  "name"       VARCHAR(100) NOT NULL,
  "position"   INTEGER NOT NULL DEFAULT 0,
  "isPublished" BOOLEAN NOT NULL DEFAULT false,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "free_subjects_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "free_subjects_position_idx"     ON "free_subjects" ("position");
CREATE INDEX "free_subjects_isPublished_idx"  ON "free_subjects" ("isPublished");

CREATE TABLE "free_chapters" (
  "id"         TEXT NOT NULL,
  "subjectId"  TEXT NOT NULL,
  "title"      VARCHAR(200) NOT NULL,
  "position"   INTEGER NOT NULL DEFAULT 0,
  "isPublished" BOOLEAN NOT NULL DEFAULT false,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "free_chapters_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "free_chapters_subjectId_position_idx" ON "free_chapters" ("subjectId", "position");
CREATE INDEX "free_chapters_isPublished_idx"        ON "free_chapters" ("isPublished");

CREATE TABLE "free_topics" (
  "id"               TEXT NOT NULL,
  "chapterId"        TEXT NOT NULL,
  "title"            VARCHAR(200) NOT NULL,
  "position"         INTEGER NOT NULL DEFAULT 0,
  "provider"         "FreeContentProvider" NOT NULL,
  "providerVideoId"  VARCHAR(200) NOT NULL,
  "providerEmbedUrl" TEXT,
  "vdoCipherOtp"     TEXT,
  "durationSeconds"  INTEGER,
  "thumbnailUrl"     TEXT,
  "isPublished"      BOOLEAN NOT NULL DEFAULT false,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "free_topics_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "free_topics_chapterId_position_idx" ON "free_topics" ("chapterId", "position");
CREATE INDEX "free_topics_isPublished_idx"        ON "free_topics" ("isPublished");

CREATE TABLE "free_content_views" (
  "id"             TEXT NOT NULL,
  "topicId"        TEXT NOT NULL,
  "studentId"      TEXT NOT NULL,
  "lastViewedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "watchedSeconds" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "free_content_views_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "free_content_views_topicId_studentId_key" ON "free_content_views" ("topicId", "studentId");
CREATE INDEX "free_content_views_studentId_idx"     ON "free_content_views" ("studentId");
CREATE INDEX "free_content_views_lastViewedAt_idx"  ON "free_content_views" ("lastViewedAt");

-- ─── Foreign keys ─────────────────────────────────────────────────────────
ALTER TABLE "free_chapters"
  ADD CONSTRAINT "free_chapters_subjectId_fkey"
  FOREIGN KEY ("subjectId") REFERENCES "free_subjects"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "free_topics"
  ADD CONSTRAINT "free_topics_chapterId_fkey"
  FOREIGN KEY ("chapterId") REFERENCES "free_chapters"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "free_content_views"
  ADD CONSTRAINT "free_content_views_topicId_fkey"
  FOREIGN KEY ("topicId") REFERENCES "free_topics"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "free_content_views"
  ADD CONSTRAINT "free_content_views_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "students"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;