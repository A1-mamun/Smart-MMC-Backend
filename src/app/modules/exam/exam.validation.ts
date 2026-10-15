import { z } from 'zod';

const sectionType = z.enum(['MCQ', 'WRITTEN']);

// Per-section input. Used both at create and update; `id` is optional so the
// admin can keep existing sections (by id) while adding new ones.
const sectionInputSchema = z.object({
  id: z.string().uuid().optional(),
  type: sectionType,
  name: z.string().trim().min(1).max(80),
  totalQuestions: z.coerce.number().int().min(1).max(500),
  marksPerQuestion: z.coerce.number().min(0).max(1000),
  position: z.coerce.number().int().min(0).optional(),
});

/**
 * Per-exam weekly schedule slot. Mirrors the BatchDay shape on
 * the course side so the kiosk can render the exam timetable
 * with the same UI primitives (days/times rows, duration,
 * optional per-slot admit gates). Optional fields default to
 * safe values on the service side; the schema only enforces
 * shape, not admission semantics.
 */
const examScheduleInputSchema = z
  .object({
    // Optional id for in-place updates (preserves any FKs).
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(50).optional(),
    days: z.array(z.string().trim().min(1)).min(1, 'At least one day is required'),
    times: z
      .array(
        z
          .string()
          .trim()
          .regex(
            /^(0?[1-9]|1[0-2]):[0-5][0-9]\s?(AM|PM)$/i,
            'Time must be in "h:mm AM/PM" format (e.g. 7:00 AM, 4:00 PM)',
          ),
      )
      .min(1, 'At least one time is required'),
    durationMinutes: z
      .number()
      .int('Duration must be a whole number of minutes')
      .min(1, 'Duration must be at least 1 minute')
      .max(600, 'Duration cannot exceed 10 hours (600 min)'),
    slotStates: z.array(z.boolean()).optional(),
    manualWindowOverride: z.array(z.boolean()).optional(),
  })
  .strict();

const createExamSchema = z.object({
  body: z
    .object({
      title: z.string().trim().min(2).max(200),
      syllabus: z.string().min(1).max(10_000),
      examDate: z.coerce.date(),
      // Wall-clock window for the exam on `examDate`. Optional —
      // legacy rows and quick "date only" creates don't need a
      // time-of-day. When supplied, the kiosk surfaces the exact
      // "Happening now" / "Starts at HH:MM" indicators and the
      // SMS template can render {startTime} in addition to
      // {examDate}. `endTime` must be after `startTime` when both
      // are set — validated here at the schema boundary.
      startTime: z.coerce.date().optional().nullable(),
      endTime: z.coerce.date().optional().nullable(),
      courseId: z.string().uuid('Select a course'),
      sections: z.array(sectionInputSchema).min(1).max(20),
      // Optional weekly schedule (days + times). Empty array
      // means "no weekly schedule, just a one-shot exam on
      // `examDate`" — the kiosk then renders the exam in the
      // upcoming list using `startTime`/`endTime` only.
      examSchedules: z.array(examScheduleInputSchema).max(7).optional(),
    })
    .superRefine((b, ctx) => {
      // Cross-field check: if both startTime and endTime are
      // supplied, endTime must be after startTime. A single
      // null in either position is fine ("time-only" / "end-
      // only" / "no time" all valid). Same check on the update
      // schema below.
      if (
        b.startTime instanceof Date &&
        b.endTime instanceof Date &&
        b.endTime.getTime() <= b.startTime.getTime()
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['endTime'],
          message: 'endTime must be after startTime',
        });
      }
    }),
});

const updateExamSchema = z.object({
  body: z
    .object({
      title: z.string().trim().min(2).max(200).optional(),
      syllabus: z.string().min(1).max(10_000).optional(),
      examDate: z.coerce.date().optional(),
      startTime: z.coerce.date().optional().nullable(),
      endTime: z.coerce.date().optional().nullable(),
      courseId: z.string().uuid().optional(),
      sections: z.array(sectionInputSchema).min(1).max(20).optional(),
      // Full replacement of the weekly schedule list. Sending an
      // empty array wipes all rows; omit the field to leave the
      // existing schedule untouched.
      examSchedules: z.array(examScheduleInputSchema).max(7).optional(),
    })
    .superRefine((b, ctx) => {
      // Mirror the create schema's cross-field check. Only
      // fires when BOTH times are present in this PATCH; a
      // partial PATCH that only sets one of them is fine.
      if (
        b.startTime instanceof Date &&
        b.endTime instanceof Date &&
        b.endTime.getTime() <= b.startTime.getTime()
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['endTime'],
          message: 'endTime must be after startTime',
        });
      }
    }),
  params: z.object({ id: z.string().uuid() }),
});

const setPublishSchema = z.object({
  body: z.object({ isResultPublished: z.boolean() }),
  params: z.object({ id: z.string().uuid() }),
});

const upsertRosterSchema = z.object({
  body: z.object({
    add: z.array(z.string().uuid()).optional(),
    remove: z.array(z.string().uuid()).optional(),
  }),
  params: z.object({ id: z.string().uuid() }),
});

const setAttendanceSchema = z.object({
  body: z.object({
    studentId: z.string().uuid(),
    isAbsent: z.boolean(),
  }),
  params: z.object({ id: z.string().uuid() }),
});

// Barcode scanner input — accepts arbitrary strings (the admin pastes/scans a
// `user.studentId` value). Service verifies each is on the roster.
const bulkAttendanceByStudentIdSchema = z.object({
  body: z.object({
    studentIds: z.array(z.string().trim().min(1)).min(1).max(200),
  }),
  params: z.object({ id: z.string().uuid() }),
});

const resultSectionInputSchema = z.object({
  sectionId: z.string().uuid(),
  correctAnswers: z.coerce.number().int().min(0).optional(),
  obtainedMarks: z.coerce.number().int().min(0),
  notes: z.string().max(300).optional(),
});

const upsertResultSchema = z.object({
  body: z.object({
    studentId: z.string().uuid(),
    isAbsent: z.boolean().default(false),
    remarks: z.string().max(500).optional(),
    sections: z.array(resultSectionInputSchema).min(1),
  }),
  params: z.object({ id: z.string().uuid() }),
});

const bulkResultsSchema = z.object({
  body: z.object({
    results: z
      .array(upsertResultSchema.shape.body)
      .min(1)
      .max(500),
  }),
  params: z.object({ id: z.string().uuid() }),
});

const listExamsSchema = z.object({
  query: z.object({
    searchTerm: z.string().optional(),
    courseId: z.string().uuid().optional(),
    isResultPublished: z.coerce.boolean().optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    sortBy: z.enum(['examDate', 'title', 'createdAt']).optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
  }),
});

const idParamSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

const getMyResultsSchema = z.object({
  query: z.object({
    courseId: z.string().uuid().optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
});

const getMyUpcomingExamsSchema = z.object({
  query: z.object({
    courseId: z.string().uuid().optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
});

export const ExamValidation = {
  createExamSchema,
  updateExamSchema,
  setPublishSchema,
  upsertRosterSchema,
  setAttendanceSchema,
  bulkAttendanceByStudentIdSchema,
  upsertResultSchema,
  bulkResultsSchema,
  listExamsSchema,
  idParamSchema,
  getMyResultsSchema,
  getMyUpcomingExamsSchema,
};

export type TCreateExam = z.infer<typeof createExamSchema>['body'];
export type TUpdateExam = z.infer<typeof updateExamSchema>;
export type TSetPublish = z.infer<typeof setPublishSchema>['body'];
export type TUpsertRoster = z.infer<typeof upsertRosterSchema>['body'];
export type TSetAttendance = z.infer<typeof setAttendanceSchema>['body'];
export type TBulkAttendanceByStudentId = z.infer<
  typeof bulkAttendanceByStudentIdSchema
>['body'];
export type TUpsertResult = z.infer<typeof upsertResultSchema>['body'];
export type TBulkResults = z.infer<typeof bulkResultsSchema>['body'];
export type TListExams = z.infer<typeof listExamsSchema>['query'];
export type TGetMyResults = z.infer<typeof getMyResultsSchema>['query'];
export type TGetMyUpcomingExams = z.infer<typeof getMyUpcomingExamsSchema>['query'];
export type TExamScheduleInput = z.infer<typeof examScheduleInputSchema>;
