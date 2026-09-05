import { z } from 'zod';

const courseNames = [
  'HSC_1ST_YEAR',
  'HSC_2ND_YEAR',
  'HSC_FINAL_PREPARATION',
  'ADMISSION',
] as const;

const hscBatches = ['BATCH_25', 'BATCH_26', 'BATCH_27', 'BATCH_28'] as const;

const batchTimeRegex = /^(0?[1-9]|1[0-2]):[0-5][0-9]\s?(AM|PM)$/i;

const batchDaySchema = z
  .object({
    // Optional id — when provided during an update, the service uses it to
    // match the incoming row to an existing BatchDay and update it in place,
    // preserving any foreign-key references (e.g. StudentBatch.batchDayId).
    // When omitted, a new BatchDay row is created.
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1, 'Batch day name is required').max(50),
    days: z.array(z.string().trim().min(1)).min(1, 'At least one day is required'),
    times: z
      .array(
        z
          .string()
          .trim()
          .regex(batchTimeRegex, 'Time must be in "h:mm AM/PM" format (e.g. 7:00 AM, 4:00 PM)'),
      )
      .min(1, 'At least one time is required'),
  })
  .strict();

const createCourseSchema = z.object({
  body: z.object({
    name: z.enum(courseNames),
    description: z.string().max(500).optional(),
    fee: z.coerce.number().min(0),
    hscBatch: z.enum(hscBatches),
    batchDays: z
      .array(batchDaySchema)
      .min(1, 'At least one batch day is required')
      .max(7, 'Maximum 7 batch days per course'),
  }),
});

const updateCourseSchema = z.object({
  body: z.object({
    name: z.enum(courseNames).optional(),
    description: z.string().max(500).optional(),
    fee: z.coerce.number().min(0).optional(),
    hscBatch: z.enum(hscBatches).optional(),
    batchDays: z.array(batchDaySchema).min(1).max(7).optional(),
    isActive: z.boolean().optional(),
  }),
  params: z.object({ id: z.string().uuid() }),
});

const getAllCoursesSchema = z.object({
  query: z.object({
    isActive: z.union([z.boolean(), z.string()]).optional(),
    searchTerm: z.string().optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
  }),
});

const idParamSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

const toggleActiveSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ isActive: z.boolean() }),
});

export const CourseValidation = {
  createCourseSchema,
  updateCourseSchema,
  getAllCoursesSchema,
  idParamSchema,
  toggleActiveSchema,
};

export type TCreateCourse = z.infer<typeof createCourseSchema>['body'];
export type TUpdateCourse = z.infer<typeof updateCourseSchema>;
export type TGetAllCourses = z.infer<typeof getAllCoursesSchema>['query'];
export type TBatchDayInput = z.infer<typeof batchDaySchema>;