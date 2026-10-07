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
    // Per-batch class duration in total minutes (e.g. 75 for "1h 15m").
    // Drives the kiosk's live progress bar / countdown so the
    // operator knows how much time is left in the current class,
    // AND feeds the schedule-conflict checker so a new batch can't
    // silently overlap an existing one.
    //
    // On the UPDATE path this stays optional + nullable — legacy
    // rows created before this field existed can be re-saved
    // without forcing the admin to retroactively pick a duration.
    // `checkBatchTimeConflict` treats null/missing as the 60-min
    // default. The CREATE path overrides this schema with
    // `createBatchDaySchema` (below), which makes the field
    // REQUIRED so a fresh course never lands in the DB with an
    // unknown class length.
    durationMinutes: z
      .number()
      .int()
      .min(1, 'Duration must be at least 1 minute')
      .max(600, 'Duration cannot exceed 10 hours (600 min)')
      .nullable()
      .optional(),
    // Per-slot admit-enabled flag, parallel to `times[]`. Optional
    // on input; the service layer pads/trims to match `times.length`
    // and enforces the "exactly one ON" invariant on every read.
    // Default: omitted / empty array → all slots ON.
    // Per-slot "barcode scan allowed right now" flag, parallel
    // to `times[]`. Strictly binary — no tri-state, no
    // auto-cycle. The admin turns a slot ON at class start
    // and OFF at class end. The toggle endpoint enforces the
    // global invariant "only one ON across the entire
    // database".
    slotStates: z.array(z.boolean()).optional(),
    // Per-slot "check-in window override". When the i-th
    // element is `true`, the kiosk accepts scans for that
    // slot regardless of the wall clock (admin opened the
    // window early or kept it open past the 5-min mark).
    // When `false` or absent, the kiosk uses the default
    // 5-minute window centred on the slot start time.
    manualWindowOverride: z.array(z.boolean()).optional(),
  })
  .strict();

/**
 * Create-only BatchDay schema. Same shape as `batchDaySchema` but
 * `durationMinutes` is REQUIRED. Without this override, every fresh
 * course could land in the DB with `durationMinutes: NULL`, which
 * silently falls back to the 60-min default on the kiosk AND breaks
 * the schedule-conflict checker (a "null duration" slot would never
 * extend far enough to collide with another slot in the same window).
 *
 * The frontend form has always shipped a default of `60` in its
 * local state, but the value wasn't being pushed into RHF on mount
 * — so create payloads were sending `null` / `undefined` and the
 * backend happily stored it. Making the field required here is the
 * server-side guarantee that fixes the symptom; the frontend fix
 * (defaulting the RHF state to `60` and pushing it on mount) is in
 * `CoursesPage.tsx`.
 */
const createBatchDaySchema = batchDaySchema.extend({
  durationMinutes: z
    .number()
    .int('Duration must be a whole number of minutes')
    .min(1, 'Duration must be at least 1 minute')
    .max(600, 'Duration cannot exceed 10 hours (600 min)'),
});

const createCourseSchema = z.object({
  body: z.object({
    name: z.enum(courseNames),
    description: z.string().max(500).optional(),
    fee: z.coerce.number().min(0),
    hscBatch: z.enum(hscBatches),
    // Per-course seat cap. Required on create — every fresh
    // course must declare how many students each
    // (batchDay, batchTime) slot admits. min(1) blocks the
    // "0 seats = nobody allowed" footgun (use isActive=false
    // for that intent). max(10000) is a sanity cap. The DB
    // column stays nullable for backward compat with legacy
    // rows whose totalSeats is null (those still render the
    // "Uncapped" badge on the Courses card) — the UPDATE
    // path keeps the nullable+optional shape below so editing
    // such a legacy course doesn't break.
    totalSeats: z.coerce
      .number()
      .int('Seat cap must be a whole number')
      .min(1, 'Seat cap must be at least 1')
      .max(10000, 'Seat cap cannot exceed 10,000'),
    batchDays: z
      .array(createBatchDaySchema)
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

/**
 * Per-slot "Take attendance" toggle. The admin sets
 * `enabled = true` for the slot they want the kiosk to scan, and
 * `false` for every other slot. The service enforces the
 * "exactly one ON" invariant (flipping siblings OFF when one goes
 * ON) so the kiosk can never serve two slots concurrently.
 *
 * `batchDayId` is required to disambiguate which BatchDay the
 * slot belongs to (a course can have multiple BatchDays, each
 * with its own slot catalog). `slotIndex` is the 0-based
 * position in `BatchDay.times[]`. We accept `enabled: boolean`
 * (not nullable) so the schema rejects a request that
 * accidentally sends `null` / `undefined`.
 */
const toggleBatchSlotSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    batchDayId: z.string().uuid('batchDayId must be a valid UUID'),
    slotIndex: z
      .number()
      .int('slotIndex must be an integer')
      .min(0, 'slotIndex must be ≥ 0')
      .max(6, 'slotIndex must be ≤ 6 (max 7 batch days × 1 slot)'),
    enabled: z.boolean(),
  }),
});

/**
 * Toggle the per-slot "check-in window override" flag. The admin
 * flips this when they want the kiosk to accept scans for the
 * matched slot OUTSIDE the default 5-minute window — e.g.
 * opening the window early for an early arrival, or keeping it
 * open past the 5-min mark because the class was delayed. The
 * override is per-slot (the i-th element in the parallel
 * `manualWindowOverride` array) and is independent of the
 * `slotStates[i]` admit flag — a slot can be ON with the
 * default window (override off), ON with the override on
 * (window always open), OFF (kiosk locked regardless of
 * override), etc.
 *
 * The matched slot must currently be ON (slotStates[i] === true)
 * — turning the window override on for a disabled slot would
 * be a no-op, since the kiosk rejects scans for disabled
 * slots regardless. We don't reject the request here for
 * idempotency (the admin can flip either switch
 * independently) but the server-side check-in guard enforces
 * the ON requirement at scan time.
 */
const setSlotWindowOverrideSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    batchDayId: z.string().uuid('batchDayId must be a valid UUID'),
    slotIndex: z
      .number()
      .int('slotIndex must be an integer')
      .min(0, 'slotIndex must be ≥ 0')
      .max(6, 'slotIndex must be ≤ 6 (max 7 batch days × 1 slot)'),
    open: z.boolean(),
  }),
});

export const CourseValidation = {
  createCourseSchema,
  updateCourseSchema,
  getAllCoursesSchema,
  idParamSchema,
  toggleActiveSchema,
  setStatusSchema,
  toggleAdmitAnotherCourseSchema,
  toggleBatchSlotSchema,
  setSlotWindowOverrideSchema,
};

export type TCreateCourse = z.infer<typeof createCourseSchema>['body'];
export type TUpdateCourse = z.infer<typeof updateCourseSchema>;
export type TGetAllCourses = z.infer<typeof getAllCoursesSchema>['query'];
export type TSetStatus = z.infer<typeof setStatusSchema>;
export type TToggleAdmitAnotherCourse = z.infer<typeof toggleAdmitAnotherCourseSchema>;
export type TToggleBatchSlot = z.infer<typeof toggleBatchSlotSchema>;
export type TSetSlotWindowOverride = z.infer<typeof setSlotWindowOverrideSchema>;
export type TBatchDayInput = z.infer<typeof batchDaySchema>;