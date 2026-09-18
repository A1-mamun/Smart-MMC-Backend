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

const createExamSchema = z.object({
  body: z.object({
    title: z.string().trim().min(2).max(200),
    syllabus: z.string().min(1).max(10_000),
    examDate: z.coerce.date(),
    courseId: z.string().uuid('Select a course'),
    sections: z.array(sectionInputSchema).min(1).max(20),
  }),
});

const updateExamSchema = z.object({
  body: z.object({
    title: z.string().trim().min(2).max(200).optional(),
    syllabus: z.string().min(1).max(10_000).optional(),
    examDate: z.coerce.date().optional(),
    courseId: z.string().uuid().optional(),
    sections: z.array(sectionInputSchema).min(1).max(20).optional(),
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
