import { z } from 'zod';

const idParam = z.object({
  params: z.object({ id: z.string().uuid('Invalid id') }),
});

const subjectIdParam = z.object({
  params: z.object({ subjectId: z.string().uuid('Invalid subject id') }),
});

const chapterIdParam = z.object({
  params: z.object({ chapterId: z.string().uuid('Invalid chapter id') }),
});

const topicIdParam = z.object({
  params: z.object({ id: z.string().uuid('Invalid topic id') }),
});

const createSubjectSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100),
    position: z.number().int().min(0).optional(),
    isPublished: z.boolean().optional(),
  }),
});

const updateSubjectSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).optional(),
    position: z.number().int().min(0).optional(),
    isPublished: z.boolean().optional(),
  }),
});

const createChapterSchema = z.object({
  body: z.object({
    title: z.string().min(1).max(200),
    position: z.number().int().min(0).optional(),
    isPublished: z.boolean().optional(),
  }),
});

const updateChapterSchema = z.object({
  body: z.object({
    title: z.string().min(1).max(200).optional(),
    position: z.number().int().min(0).optional(),
    isPublished: z.boolean().optional(),
  }),
});

// providerVideoId accepts YouTube IDs (~11 chars), VdoCipher IDs (longer
// hex), or full https://youtu.be/<id> / youtube.com/watch?v=<id> URLs.
// We normalise at the schema layer via Zod .transform; note that this
// transform doesn't propagate into req.body (validateRequest only checks
// the schema — see middleware comment) — the service layer re-applies
// `normaliseProviderVideoId` so the persisted value is always the raw
// id regardless of how the admin typed it.
const normaliseProviderVideoId = (raw: string): string => {
  const trimmed = raw.trim();
  if (/^[a-zA-Z0-9_-]{6,64}$/.test(trimmed)) return trimmed;
  const short = trimmed.match(/youtu\.be\/([a-zA-Z0-9_-]{6,64})/);
  if (short) return short[1];
  const long = trimmed.match(
    /youtube\.com\/(?:embed\/|watch\?v=)([a-zA-Z0-9_-]{6,64})/,
  );
  if (long) return long[1];
  return trimmed;
};

export { normaliseProviderVideoId };

const createTopicSchema = z.object({
  body: z.object({
    title: z.string().min(1).max(200),
    position: z.number().int().min(0).optional(),
    provider: z.enum(['YOUTUBE', 'VDOCIPHER', 'FILE']).default('YOUTUBE'),
    providerVideoId: z.string().min(1).max(500),
    durationSeconds: z.number().int().min(0).nullable().optional(),
    thumbnailUrl: z.string().url().max(2000).nullable().optional(),
    isPublished: z.boolean().optional(),
  }),
});

const updateTopicSchema = z.object({
  body: z.object({
    title: z.string().min(1).max(200).optional(),
    position: z.number().int().min(0).optional(),
    provider: z.enum(['YOUTUBE', 'VDOCIPHER', 'FILE']).optional(),
    providerVideoId: z.string().min(1).max(500).optional(),
    durationSeconds: z.number().int().min(0).nullable().optional(),
    thumbnailUrl: z.string().url().max(2000).nullable().optional(),
    isPublished: z.boolean().optional(),
  }),
});

/**
 * Single-step "create free class" flow. Admin picks:
 *   - subject (must match the FreeClassSubjects enum in the frontend —
 *     server uses this as the FreeSubject.name verbatim, creating the
 *     subject row on first use)
 *   - one of:
 *       (a) chapterId: append this topic to an existing chapter, OR
 *       (b) chapterNumber + chapterName: upsert a new chapter inline
 *           (so the modal can offer "Create new chapter…" without a
 *           separate round-trip)
 *   - topic title + YouTube URL (URL or id)
 *
 * Server normalises the YouTube URL/id → raw id. Returns the created
 * topic along with the resolved subject + chapter ids so the admin
 * UI can deep-link or refresh local state.
 */
const createFreeClassSchema = z
  .object({
    body: z.object({
      subjectName: z.enum(['Math 1st Paper', 'Math 2nd Paper'], {
        message: 'Subject must be "Math 1st Paper" or "Math 2nd Paper"',
      }),
      // Either append to an existing chapter…
      chapterId: z
        .string()
        .uuid('Invalid chapter id')
        .optional(),
      // …or create a new chapter inline. Both sets of fields are
      // optional here; the .refine below enforces that exactly one
      // path is supplied.
      chapterNumber: z
        .number()
        .int()
        .min(1, 'Chapter number must be at least 1')
        .max(50, 'Chapter number must be at most 50')
        .optional(),
      chapterName: z
        .string()
        .min(1, 'Chapter name is required')
        .max(200, 'Chapter name must be at most 200 characters')
        .optional(),
      topicTitle: z.string().min(1).max(200),
      topicUrl: z.string().min(1).max(500),
      isPublished: z.boolean().optional(),
      durationSeconds: z.number().int().min(0).nullable().optional(),
      thumbnailUrl: z.string().url().max(2000).nullable().optional(),
    }),
  })
  .refine(
    (v) => {
      const hasExisting = !!v.body.chapterId;
      const hasNew =
        !!v.body.chapterNumber && !!v.body.chapterName?.trim();
      return hasExisting || hasNew;
    },
    {
      message: 'Pick an existing chapter or fill chapter number + name',
      path: ['body'],
    },
  );

export const FreeClassAdminValidation = {
  subjectIdParam,
  chapterIdParam,
  topicIdParam,
  createSubjectSchema,
  updateSubjectSchema,
  createChapterSchema,
  updateChapterSchema,
  createTopicSchema,
  updateTopicSchema,
  createFreeClassSchema,
  idParam,
  // GET /free-class/admin/chapters?subjectId=... — returns chapters
  // scoped to a subject so the create-class modal can populate its
  // chapter picker.
  listChaptersSchema: z.object({
    query: z.object({
      subjectId: z.string().uuid('Invalid subject id').optional(),
    }),
  }),

  /**
   * POST /free-class/admin/chapters — dedicated "create a chapter"
   * endpoint that does NOT require a topic. Lets the admin pre-create
   * the chapter list before adding videos. The chapter is created
   * (or reused by title) under the named subject; the subject is
   * upserted the same way the topic-create flow does it.
   */
  createChapterOnlySchema: z.object({
    body: z.object({
      subjectName: z.enum(['Math 1st Paper', 'Math 2nd Paper'], {
        message: 'Subject must be "Math 1st Paper" or "Math 2nd Paper"',
      }),
      chapterNumber: z
        .number()
        .int()
        .min(1, 'Chapter number must be at least 1')
        .max(50, 'Chapter number must be at most 50'),
      chapterName: z
        .string()
        .min(1, 'Chapter name is required')
        .max(200, 'Chapter name must be at most 200 characters'),
      isPublished: z.boolean().optional(),
    }),
  }),
};