import { z } from 'zod';

const courseNames = [
  'HSC_1ST_YEAR',
  'HSC_2ND_YEAR',
  'HSC_FINAL_PREPARATION',
  'ADMISSION',
] as const;

const courseStatuses = ['ADMISSION', 'ONGOING', 'COMPLETE'] as const;

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
    // Per-course seat cap. NULL = uncapped. The DB DEFAULT is 120, so
    // omitting this in a create payload still gets the safe default
    // server-side. min(1) blocks the "0 seats = nobody allowed" footgun
    // (use isActive=false for that intent). max(10000) is a sanity cap.
    totalSeats: z.coerce.number().int().min(1).max(10000).nullable().optional(),
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
    totalSeats: z.coerce.number().int().min(1).max(10000).nullable().optional(),
    batchDays: z.array(batchDaySchema).min(1).max(7).optional(),
    isActive: z.boolean().optional(),
    // Course-level status (ADMISSION / ONGOING / COMPLETE). Most admins
    // will use the dedicated `setStatusSchema` endpoint (single-click
    // transition that also keeps `isAllowAdmitAnotherCourse` in sync),
    // but we keep this field editable from the generic update endpoint
    // so the Course edit modal can still touch it if needed.
    status: z.enum(courseStatuses).optional(),
    // Independent gate flag. The single-click status-set endpoint keeps
    // this consistent with `status` (COMPLETE → on, anything else → off);
    // we expose it here so an admin can override without moving the
    // course to COMPLETE (e.g. temporarily open re-admission while a
    // course is still ADMISSION to clean up stragglers).
    isAllowAdmitAnotherCourse: z.boolean().optional(),
  }),
  params: z.object({ id: z.string().uuid() }),
});

const getAllCoursesSchema = z.object({
  query: z.object({
    isActive: z.union([z.boolean(), z.string()]).optional(),
    // Course-level status filter. Tri-state on the wire: undefined
    // returns everyone; one of ADMISSION/ONGOING/COMPLETE narrows to
    // that stage.
    status: z.enum(courseStatuses).optional(),
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

// Dedicated lifecycle endpoint — single-click status transition from
// the Courses page. The service keeps `isAllowAdmitAnotherCourse`
// in sync with the new status (COMPLETE → flag on; anything else →
// flag off) so the two fields can't drift under the standard flow. An
// admin who wants to decouple them can still do so via PATCH /:id
// or the dedicated toggle endpoint below.
const setStatusSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    status: z.enum(courseStatuses),
  }),
});

// Independent manual override for the `isAllowAdmitAnotherCourse`
// gate. Decouples the gate from the status enum so an admin can
// (a) let a still-admitting course allow re-admission to clean up
// stragglers, or (b) keep an `ONGOING` batch's gate closed even
// mid-stream. The status-set endpoint resets the flag to its
// default mapping on the next status transition, so this is a
// short-term override, not a permanent decouple.
const toggleAdmitAnotherCourseSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ isAllowAdmitAnotherCourse: z.boolean() }),
});

export const CourseValidation = {
  createCourseSchema,
  updateCourseSchema,
  getAllCoursesSchema,
  idParamSchema,
  toggleActiveSchema,
  setStatusSchema,
  toggleAdmitAnotherCourseSchema,
};

export type TCreateCourse = z.infer<typeof createCourseSchema>['body'];
export type TUpdateCourse = z.infer<typeof updateCourseSchema>;
export type TGetAllCourses = z.infer<typeof getAllCoursesSchema>['query'];
export type TSetStatus = z.infer<typeof setStatusSchema>;
export type TToggleAdmitAnotherCourse = z.infer<typeof toggleAdmitAnotherCourseSchema>;
export type TBatchDayInput = z.infer<typeof batchDaySchema>;