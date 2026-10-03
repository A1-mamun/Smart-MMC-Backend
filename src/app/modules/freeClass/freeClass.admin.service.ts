import httpStatus from 'http-status';
import prisma from '../../utils/prisma';
import AppError from '../../errors/AppError';
import { normaliseProviderVideoId } from './freeClass.admin.validation';

/**
 * Admin CRUD for the free-class content tree. Admins see every subject,
 * chapter and topic — including unpublished ones — and have the raw
 * providerVideoId they need to wire up new videos.
 */
const getAllSubjectsForAdmin = async () => {
  return prisma.freeSubject.findMany({
    orderBy: { position: 'asc' },
    include: {
      chapters: {
        orderBy: { position: 'asc' },
        include: {
          topics: {
            orderBy: { position: 'asc' },
            // No select — admins need the full row including
            // providerVideoId / providerEmbedUrl / vdoCipherOtp.
          },
        },
      },
    },
  });
};

/**
 * Lightweight chapter list for the create-class modal's chapter
 * picker. Optionally filtered by subjectId; returns the chapters with
 * a small topic count so the picker can render "Chapter 1 (3 topics)"
 * without a second round-trip.
 */
const listChaptersForAdmin = async (subjectId?: string) => {
  return prisma.freeChapter.findMany({
    where: subjectId ? { subjectId } : undefined,
    orderBy: [{ subjectId: 'asc' }, { position: 'asc' }],
    include: {
      _count: { select: { topics: true } },
    },
  });
};

const createSubjectToDB = async (payload: {
  name: string;
  position?: number;
  isPublished?: boolean;
}) => {
  return prisma.freeSubject.create({
    data: {
      name: payload.name,
      position: payload.position ?? 0,
      isPublished: payload.isPublished ?? false,
    },
  });
};

const updateSubjectToDB = async (
  id: string,
  payload: {
    name?: string;
    position?: number;
    isPublished?: boolean;
  },
) => {
  const existing = await prisma.freeSubject.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError(httpStatus.NOT_FOUND, 'Subject not found');
  }
  return prisma.freeSubject.update({ where: { id }, data: payload });
};

const deleteSubjectFromDB = async (id: string) => {
  const existing = await prisma.freeSubject.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError(httpStatus.NOT_FOUND, 'Subject not found');
  }
  // Cascades to chapters + topics via FK onDelete: Cascade.
  await prisma.freeSubject.delete({ where: { id } });
};

const createChapterToDB = async (
  subjectId: string,
  payload: { title: string; position?: number; isPublished?: boolean },
) => {
  const subject = await prisma.freeSubject.findUnique({ where: { id: subjectId } });
  if (!subject) {
    throw new AppError(httpStatus.NOT_FOUND, 'Subject not found');
  }
  const position = payload.position ?? 0;
  // Keep chapterNumber and position in lockstep. The unique index on
  // (subjectId, chapterNumber) means a duplicate-chapterNumber
  // collision surfaces as Prisma P2002 — we convert it to a 409 with
  // a friendly message below.
  try {
    return await prisma.freeChapter.create({
      data: {
        subjectId,
        title: payload.title,
        position,
        chapterNumber: position || null,
        isPublished: payload.isPublished ?? false,
      },
    });
  } catch (err) {
    if (
      err instanceof AppError ||
      !(err as { code?: string }).code ||
      (err as { code: string }).code !== 'P2002'
    ) {
      throw err;
    }
    throw new AppError(
      httpStatus.CONFLICT,
      `Chapter ${position} already exists for this subject. Pick a different chapter number.`,
    );
  }
};

const updateChapterToDB = async (
  id: string,
  payload: { title?: string; position?: number; isPublished?: boolean },
) => {
  const existing = await prisma.freeChapter.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError(httpStatus.NOT_FOUND, 'Chapter not found');
  }
  // Mirror position → chapterNumber so the two fields never drift.
  const data: {
    title?: string;
    position?: number;
    chapterNumber?: number | null;
    isPublished?: boolean;
  } = { ...payload };
  if (typeof payload.position === 'number') {
    data.chapterNumber = payload.position || null;
  }
  return prisma.freeChapter.update({ where: { id }, data });
};

const deleteChapterFromDB = async (id: string) => {
  const existing = await prisma.freeChapter.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError(httpStatus.NOT_FOUND, 'Chapter not found');
  }
  // Topics cascade-delete via FK.
  await prisma.freeChapter.delete({ where: { id } });
};

const createTopicToDB = async (
  chapterId: string,
  payload: {
    title: string;
    position?: number;
    provider: 'YOUTUBE' | 'VDOCIPHER' | 'FILE';
    providerVideoId: string;
    durationSeconds?: number | null;
    thumbnailUrl?: string | null;
    isPublished?: boolean;
  },
) => {
  const chapter = await prisma.freeChapter.findUnique({ where: { id: chapterId } });
  if (!chapter) {
    throw new AppError(httpStatus.NOT_FOUND, 'Chapter not found');
  }
  return prisma.freeTopic.create({
    data: {
      chapterId,
      title: payload.title,
      position: payload.position ?? 0,
      provider: payload.provider,
      providerVideoId: normaliseProviderVideoId(payload.providerVideoId),
      durationSeconds: payload.durationSeconds ?? null,
      thumbnailUrl: payload.thumbnailUrl ?? null,
      isPublished: payload.isPublished ?? false,
    },
  });
};

const updateTopicToDB = async (
  id: string,
  payload: {
    title?: string;
    position?: number;
    provider?: 'YOUTUBE' | 'VDOCIPHER' | 'FILE';
    providerVideoId?: string;
    durationSeconds?: number | null;
    thumbnailUrl?: string | null;
    isPublished?: boolean;
  },
) => {
  const existing = await prisma.freeTopic.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError(httpStatus.NOT_FOUND, 'Topic not found');
  }
  // Build the data payload without mutating the input — only normalise
  // providerVideoId when the admin actually sent it.
  const { providerVideoId, ...rest } = payload;
  const data = {
    ...rest,
    ...(providerVideoId !== undefined
      ? { providerVideoId: normaliseProviderVideoId(providerVideoId) }
      : {}),
  };
  return prisma.freeTopic.update({ where: { id }, data });
};

const deleteTopicFromDB = async (id: string) => {
  const existing = await prisma.freeTopic.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError(httpStatus.NOT_FOUND, 'Topic not found');
  }
  // FreeContentView rows cascade-delete via FK.
  await prisma.freeTopic.delete({ where: { id } });
};

/**
 * Admin preview — derives the embed URL without persisting a view
 * row (the student `/play` endpoint upserts FreeContentView for
 * analytics; we don't want preview clicks polluting that).
 */
/**
 * Single-step "create free class" flow. Looks up or creates the subject
 * + chapter + topic all in one transaction so a partial failure
 * doesn't leave dangling rows.
 *
 *   - subject: matched by name. Created (position = 0, unpublished) if
 *     it doesn't exist yet.
 *   - chapter: two paths.
 *       (a) chapterId supplied → use that exact chapter row (it must
 *           belong to the chosen subject — adapter refuses otherwise).
 *       (b) chapterNumber + chapterName → match by (subjectId, title).
 *           Re-using a name upserts the chapter; otherwise a new one
 *           is created with `position = chapterNumber`.
 *   - topic: created with the next available position in the chapter
 *     (1 + current topic count).
 *
 * Returns the full tree branch (subject, chapter, topic) so the admin
 * UI can deep-link to it without a follow-up GET.
 */
const createFreeClassToDB = async (payload: {
  subjectName: 'Math 1st Paper' | 'Math 2nd Paper';
  chapterId?: string;
  chapterNumber?: number;
  chapterName?: string;
  topicTitle: string;
  topicUrl: string;
  isPublished?: boolean;
  durationSeconds?: number | null;
  thumbnailUrl?: string | null;
}) => {
  const isPublished = payload.isPublished ?? true;
  const providerVideoId = normaliseProviderVideoId(payload.topicUrl);

  try {
    return await prisma.$transaction(async (tx) => {
    // 1. Upsert subject (matched by name).
    let subject = await tx.freeSubject.findFirst({
      where: { name: payload.subjectName },
    });
    if (!subject) {
      subject = await tx.freeSubject.create({
        data: {
          name: payload.subjectName,
          position: 0,
          isPublished,
        },
      });
    } else if (isPublished && !subject.isPublished) {
      // Auto-publish when the admin publishes the first chapter in
      // this subject — keeps the content tree consistent without a
      // separate subject-level toggle.
      subject = await tx.freeSubject.update({
        where: { id: subject.id },
        data: { isPublished: true },
      });
    }

    // 2. Resolve chapter.
    let chapter;
    if (payload.chapterId) {
      // Use the admin-selected existing chapter. Validate ownership
      // so an admin can't smuggle a chapter from another subject.
      chapter = await tx.freeChapter.findUnique({
        where: { id: payload.chapterId },
      });
      if (!chapter || chapter.subjectId !== subject.id) {
        throw new AppError(
          httpStatus.BAD_REQUEST,
          'Selected chapter does not belong to the chosen subject',
        );
      }
      if (isPublished && !chapter.isPublished) {
        chapter = await tx.freeChapter.update({
          where: { id: chapter.id },
          data: { isPublished: true },
        });
      }
    } else {
      // Upsert by (subjectId, chapterNumber). The chapter's
      // `title` is the admin's chapter name; if the chapter
      // already exists for this number, we throw a 409 with a
      // friendly message rather than silently re-using the old
      // name (which would surprise the admin when they typo'd a
      // different name).
      const chapterTitle = payload.chapterName!.trim();
      const existing = await tx.freeChapter.findFirst({
        where: {
          subjectId: subject.id,
          chapterNumber: payload.chapterNumber!,
        },
      });
      if (!existing) {
        chapter = await tx.freeChapter.create({
          data: {
            subjectId: subject.id,
            title: chapterTitle,
            position: payload.chapterNumber!,
            chapterNumber: payload.chapterNumber!,
            isPublished,
          },
        });
      } else if (existing.title === chapterTitle) {
        // Same chapter number + same name — idempotent. Reuse.
        chapter = existing;
        if (isPublished && !chapter.isPublished) {
          chapter = await tx.freeChapter.update({
            where: { id: chapter.id },
            data: { isPublished: true },
          });
        }
      } else {
        throw new AppError(
          httpStatus.CONFLICT,
          `Chapter ${payload.chapterNumber} already exists for ${payload.subjectName} (named "${existing.title}"). Pick a different chapter number, or reuse the existing chapter.`,
        );
      }
    }

    // 3. Create the topic (always new — no upsert; topics are
    //    per-video, and the admin can edit/delete the row after).
    const existingTopics = await tx.freeTopic.count({
      where: { chapterId: chapter.id },
    });
    const topic = await tx.freeTopic.create({
      data: {
        chapterId: chapter.id,
        title: payload.topicTitle.trim(),
        position: existingTopics,
        provider: 'YOUTUBE',
        providerVideoId,
        durationSeconds: payload.durationSeconds ?? null,
        thumbnailUrl: payload.thumbnailUrl ?? null,
        isPublished,
      },
    });

    return {
      subject,
      chapter,
      topic,
    };
    });
  } catch (err) {
    // Race-condition guard: if the (subjectId, chapterNumber)
    // collision slipped past the deterministic check above (two
    // parallel requests both reading "no existing chapter"),
    // Prisma throws P2002 — convert it to the same friendly 409
    // the deterministic path raises.
    if (
      err instanceof AppError ||
      !(err as { code?: string }).code ||
      (err as { code: string }).code !== 'P2002'
    ) {
      throw err;
    }
    throw new AppError(
      httpStatus.CONFLICT,
      `Chapter ${payload.chapterNumber} already exists for ${payload.subjectName}. Pick a different chapter number, or pick the existing chapter from the picker.`,
    );
  }
};

/**
 * Dedicated "create a chapter" flow. Admin pre-creates a chapter
 * (name + chapterNumber) without any topic — useful when the admin
 * wants to scaffold the chapter list first, then drop videos in
 * later. Subject is upserted by name (same pattern as createFreeClass).
 *
 * Throws a 409 with a friendly message when the (subjectId,
   chapterNumber) pair already exists — the chapter number is the
   admin's identity, so a duplicate is almost always a typo they
   want to correct.
 */
const createChapterOnlyToDB = async (payload: {
  subjectName: 'Math 1st Paper' | 'Math 2nd Paper';
  chapterNumber: number;
  chapterName: string;
  isPublished?: boolean;
}) => {
  const isPublished = payload.isPublished ?? true;
  const chapterTitle = payload.chapterName.trim();

  try {
    return await prisma.$transaction(async (tx) => {
      let subject = await tx.freeSubject.findFirst({
        where: { name: payload.subjectName },
      });
      if (!subject) {
        subject = await tx.freeSubject.create({
          data: { name: payload.subjectName, position: 0, isPublished },
        });
      } else if (isPublished && !subject.isPublished) {
        subject = await tx.freeSubject.update({
          where: { id: subject.id },
          data: { isPublished: true },
        });
      }

      let chapter = await tx.freeChapter.findFirst({
        where: {
          subjectId: subject.id,
          chapterNumber: payload.chapterNumber,
        },
      });
      if (!chapter) {
        chapter = await tx.freeChapter.create({
          data: {
            subjectId: subject.id,
            title: chapterTitle,
            position: payload.chapterNumber,
            chapterNumber: payload.chapterNumber,
            isPublished,
          },
        });
      } else if (chapter.title !== chapterTitle) {
        // Same chapter number but different name — almost always a
        // typo from the admin. Refuse rather than silently
        // overwriting the existing chapter's title (which would
        // rename an entire chapter the students are already
        // studying).
        throw new AppError(
          httpStatus.CONFLICT,
          `Chapter ${payload.chapterNumber} already exists for ${payload.subjectName} (named "${chapter.title}"). Pick a different chapter number, or use the existing chapter.`,
        );
      } else if (isPublished && !chapter.isPublished) {
        chapter = await tx.freeChapter.update({
          where: { id: chapter.id },
          data: { isPublished: true },
        });
      }

      return { subject, chapter };
    });
  } catch (err) {
    // Map Prisma P2002 (unique violation) on (subjectId,
    // chapterNumber) to a 409 with the same wording as above so the
    // race-condition path looks identical to the deterministic one.
    if (
      err instanceof AppError ||
      !(err as { code?: string }).code ||
      (err as { code: string }).code !== 'P2002'
    ) {
      throw err;
    }
    throw new AppError(
      httpStatus.CONFLICT,
      `Chapter ${payload.chapterNumber} already exists for ${payload.subjectName}. Pick a different chapter number, or pick the existing chapter from the picker.`,
    );
  }
};

const previewTopicPlayback = (
  topic: {
    id: string;
    provider: 'YOUTUBE' | 'VDOCIPHER' | 'FILE';
    providerVideoId: string;
  },
) => {
  if (topic.provider === 'YOUTUBE') {
    return {
      provider: 'YOUTUBE' as const,
      topicId: topic.id,
      embedUrl: `https://www.youtube.com/embed/${topic.providerVideoId}`,
      expiresAt: null,
    };
  }
  throw new AppError(
    httpStatus.NOT_IMPLEMENTED,
    `Preview for ${topic.provider} is not yet implemented`,
  );
};

export const FreeClassAdminService = {
  getAllSubjectsForAdmin,
  listChaptersForAdmin,
  createSubjectToDB,
  updateSubjectToDB,
  deleteSubjectFromDB,
  createChapterToDB,
  updateChapterToDB,
  deleteChapterFromDB,
  createTopicToDB,
  updateTopicToDB,
  deleteTopicFromDB,
  createFreeClassToDB,
  createChapterOnlyToDB,
  previewTopicPlayback,
};