import { z } from 'zod';

const bloodGroups = [
  'A_POSITIVE',
  'A_NEGATIVE',
  'B_POSITIVE',
  'B_NEGATIVE',
  'AB_POSITIVE',
  'AB_NEGATIVE',
  'O_POSITIVE',
  'O_NEGATIVE',
] as const;

const boards = [
  'DHAKA',
  'CHITTAGONG',
  'RAJSHAHI',
  'COMILLA',
  'SYLHET',
  'BARISAL',
  'JESSORE',
  'MYMENSINGH',
  'MADRASAH',
  'TECHNICAL',
] as const;

const hscBatches = ['BATCH_25', 'BATCH_26', 'BATCH_27', 'BATCH_28'] as const;
// const courseNames = [
//   'HSC_1ST_YEAR',
//   'HSC_2ND_YEAR',
//   'HSC_FINAL_PREPARATION',
//   'ADMISSION',
// ] as const;

const phoneRegex = /^01[3-9]\d{8}$/;
const batchTimeRegex = /^(0?[1-9]|1[0-2]):[0-5][0-9]\s?(AM|PM)$/i;

const admitStudentSchema = z.object({
  body: z.object({
    // Only the truly load-bearing fields are required. The
    // admission desk frequently takes students with incomplete
    // profiles (walk-ins who can't recall their SSC institute,
    // guardian info not on hand, etc.) — the rest can be filled
    // in later from the student detail page.
    name: z.string().trim().min(2).max(100),
    nickname: z.string().max(50).optional().nullable().or(z.literal('')),
    college: z.string().max(200).optional().nullable().or(z.literal('')),
    mobile: z.string().regex(phoneRegex, 'Invalid BD mobile number'),
    bloodGroup: z.enum(bloodGroups).optional().nullable(),
    // Father block — now optional. The field still goes through
    // `nullIfEmpty` in the service so an empty string becomes a
    // real `null` instead of polluting the DB with `""`.
    fatherName: z.string().max(100).optional().nullable().or(z.literal('')),
    fatherOccupation: z
      .string()
      .max(100)
      .optional()
      .nullable()
      .or(z.literal('')),
    fatherMobile: z
      .string()
      .regex(phoneRegex, 'Invalid BD mobile number')
      .optional()
      .nullable()
      .or(z.literal('')),
    // Mother block — was already optional.
    motherName: z.string().max(100).optional().nullable().or(z.literal('')),
    motherOccupation: z.string().max(100).optional().nullable().or(z.literal('')),
    motherMobile: z
      .string()
      .regex(phoneRegex, 'Invalid BD mobile number')
      .optional()
      .nullable()
      .or(z.literal('')),
    // Address — was required (Upazila + District), now all optional.
    addressVillage: z.string().max(200).optional().nullable().or(z.literal('')),
    addressPostOffice: z.string().max(100).optional().nullable().or(z.literal('')),
    addressUpozila: z.string().max(100).optional().nullable().or(z.literal('')),
    addressDistrict: z.string().max(100).optional().nullable().or(z.literal('')),
    // SSC — was required (institute), now all optional.
    sscInstitute: z.string().max(200).optional().nullable().or(z.literal('')),
    sscBoard: z.enum(boards).optional().nullable(),
    sscPassingYear: z.coerce
      .number()
      .int()
      .min(2010)
      .max(new Date().getFullYear())
      .optional()
      .nullable(),
    sscGpa: z.coerce.number().min(0).max(5).optional().nullable(),
    // Course / batch — still required (this is the admission itself).
    courseId: z.string().uuid('Select a course'),
    batchDayId: z.string().uuid('Select a batch day'),
    batchTime: z
      .string()
      .trim()
      .regex(batchTimeRegex, 'Time must be in "h:mm AM/PM" format (e.g. 7:00 AM)'),
    // PP (referral) linkage. Both fields optional — most students
    // are admitted with no PP. Cross-field rule below: setting
    // `ppFee` without a `ppId` is meaningless (a fee attached to
    // nobody), so we reject that combination with a 400.
    ppId: z.string().uuid('Invalid PP').optional().nullable(),
    ppFee: z.coerce
      .number()
      .min(0, 'PP fee cannot be negative')
      .max(10_000_000, 'PP fee looks too large; double-check the value')
      .optional()
      .nullable(),
  })
    .refine(
      (d) => d.ppFee == null || d.ppFee === 0 || !!d.ppId,
      {
        // Setting a positive ppFee requires a PP id. A ppFee of
        // 0 is allowed even without a ppId (it's a no-op, but
        // the admin UI may have sent both fields as zero).
        message: 'PP fee requires a PP to be selected',
        path: ['ppFee'],
      },
    ),
});

/**
 * Schema for enrolling an EXISTING student (matched by mobile) into a
 * NEW course. Strict subset of the admit schema — only the fields that
 * actually drive the reuse flow. The student profile (User/Student
 * rows) is matched on `mobile` and otherwise untouched.
 */
const enrollExistingStudentSchema = z.object({
  body: z.object({
    mobile: z.string().regex(phoneRegex, 'Invalid BD mobile number'),
    courseId: z.string().uuid('Select a course'),
    batchDayId: z.string().uuid('Select a batch day'),
    batchTime: z
      .string()
      .trim()
      .regex(batchTimeRegex, 'Time must be in "h:mm AM/PM" format (e.g. 7:00 AM)'),
    // Optional nickname fix-up — admins occasionally want to correct a
    // typo without going through the full edit-student flow.
    nickname: z.string().trim().min(1).max(50).optional(),
    // Optional PP linkage — admins may want to back-fill a referrer
    // for a student who was originally admitted without one. Same
    // cross-field rule: positive ppFee requires a ppId.
    ppId: z.string().uuid('Invalid PP').optional().nullable(),
    ppFee: z.coerce
      .number()
      .min(0, 'PP fee cannot be negative')
      .max(10_000_000, 'PP fee looks too large; double-check the value')
      .optional()
      .nullable(),
  })
    .refine(
      (d) => d.ppFee == null || d.ppFee === 0 || !!d.ppId,
      {
        message: 'PP fee requires a PP to be selected',
        path: ['ppFee'],
      },
    ),
});

const updateStudentSchema = z.object({
  body: z.object({
    name: z.string().min(2).max(100).optional(),
    nickname: z.string().max(50).optional(),
    college: z.string().max(200).optional(),
    mobile: z.string().regex(phoneRegex).optional(),
    // Same relaxations as admit — keep the edit form in sync.
    bloodGroup: z.enum(bloodGroups).optional().nullable(),
    // Father block: still required-when-present (min(2) stays so an empty
    // string cannot clear the field, which would orphan the relationship).
    fatherName: z.string().min(2).max(100).optional(),
    fatherOccupation: z.string().min(2).max(100).optional(),
    fatherMobile: z.string().regex(phoneRegex).optional(),
    motherName: z.string().min(2).max(100).optional().nullable(),
    motherOccupation: z.string().max(100).optional().nullable(),
    motherMobile: z.string().regex(phoneRegex).optional().nullable().or(z.literal('')),
    addressVillage: z.string().max(200).optional().nullable().or(z.literal('')),
    addressPostOffice: z.string().max(100).optional().nullable().or(z.literal('')),
    addressUpozila: z.string().min(1).max(100).optional(),
    addressDistrict: z.string().min(1).max(100).optional(),
    sscInstitute: z.string().min(1).max(200).optional(),
    sscBoard: z.enum(boards).optional().nullable(),
    sscPassingYear: z.coerce
      .number()
      .int()
      .min(2010)
      .max(new Date().getFullYear())
      .optional()
      .nullable(),
    sscGpa: z.coerce.number().min(0).max(5).optional().nullable(),
    // PP (referral) linkage. Same shape + cross-field rule as
    // `admitStudentSchema` and `enrollExistingStudentSchema` —
    // a positive `ppFee` requires a `ppId`; a null/zero `ppFee`
    // is fine on its own (admin may want to attach a PP later
    // without yet committing a fee). Edit form needs this so
    // admins can back-fill or clear a PP after the initial
    // admit.
    ppId: z.string().uuid('Invalid PP').optional().nullable(),
    ppFee: z.coerce
      .number()
      .min(0, 'PP fee cannot be negative')
      .max(10_000_000, 'PP fee looks too large; double-check the value')
      .optional()
      .nullable(),
  })
    .refine(
      (d) => d.ppFee == null || d.ppFee === 0 || !!d.ppId,
      {
        // Same cross-field rule as admit/enroll. A positive
        // ppFee with no ppId would orphan the commission.
        message: 'PP fee requires a PP to be selected',
        path: ['ppFee'],
      },
    ),
  params: z.object({ id: z.string().uuid() }),
});

const getAllStudentsSchema = z.object({
  query: z.object({
    searchTerm: z.string().optional(),
    hscBatch: z.enum(hscBatches).optional(),
    courseId: z.string().uuid().optional(),
    // Course lifecycle filter — narrows the cohort to students whose
    // active enrollment belongs to a course in the given stage. Useful
    // for the Students page tabs (Admission / Ongoing / Complete)
    // that mirror the Courses page tabs. When `courseId` is also
    // set, the two filters are AND-combined (courseId wins on the
    // match).
    courseStatus: z.enum(['ADMISSION', 'ONGOING', 'COMPLETE']).optional(),
    batchDay: z.string().optional(),
    batchDayId: z.string().uuid().optional(),
    batchTime: z.string().optional(),
    district: z.string().optional(),
    // SMS scenario filters — all additive (AND-combined) with the filters
    // above. `classDate` is an ISO date; we resolve it to a weekday name
    // server-side and match against BatchDay.days[]. `classTime` narrows
    // the match to a single time slot (e.g. "3:00 PM"). `scenarioCourses`
    // is a CSV of course UUIDs used by the bulk-SMS "course-wise" picker.
    // `hasDue` is the dedicated "due payments" scenario.
    classDate: z.coerce.date().optional(),
    classTime: z.string().optional(),
    scenarioCourses: z.string().optional(),
    // NOTE: avoid `z.coerce.boolean()` here — RTK Query stringifies
    // booleans to "true"/"false" before they reach the server, and
    // `Boolean("false")` is `true`. The service layer already coerces
    // these via `isTruthyQuery()`, which handles both real booleans and
    // stringified "true"/"1", so we leave them as raw `unknown` here.
    hasDue: z
      .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
      .optional(),
    // Free-vs-paid segregation. Paid dashboards pass `false` to hide
    // free-class accounts; the marketer view passes `true`; leaving it
    // unset returns everyone.
    //
    // IMPORTANT: do NOT use `z.coerce.boolean()` here. RTK Query stringifies
    // every query param via `URLSearchParams.append(key, String(value))`, so
    // the boolean `false` arrives as the literal string `"false"`. JS's
    // `Boolean("false")` is `true` (non-empty string), which would flip the
    // filter and silently show only free accounts on the paid Students page.
    // Accept the four string shapes the frontend can produce ("true"/"false"
    // stringified + actual booleans) and coerce to a real boolean ourselves.
    isFreeAccount: z
      .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === true || v === 'true' || v === '1')),
    // ISO yyyy-mm-dd — server resolves to "students with an
    // Attendance row whose `status = ABSENT` on this exact
    // date". Used by the absent-warning SMS picker on
    // /dashboard/sms. The ABSENT rows are written by the
    // attendance cron (`attendance.service →
    // markAbsenteesForFinishedSlotsToDB`) at slot-finish time,
    // so the picker reflects the system-of-record absence
    // state and matches what the attendance page shows.
    // Combines additively with the rest of the filter chain.
    absentOnDate: z.coerce.date().optional(),
    page: z.coerce.number().int().min(1).optional(),
    // Cap raised to 1000 so the bulk-SMS picker can pull the entire cohort
    // in a single request (it intentionally bypasses pagination — see
    // `RecipientsPicker.tsx`). 100 is too low: with ~10 students today the
    // picker is fine, but the picker renders 0 results once any single
    // cohort grows past that, because the backend rejects the request
    // outright as "limit too big".
    limit: z.coerce.number().int().min(1).max(1000).optional(),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
  }),
});

const idParamSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

const deleteStudentSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ hard: z.boolean().optional() }).optional(),
});

export const StudentValidation = {
  admitStudentSchema,
  enrollExistingStudentSchema,
  updateStudentSchema,
  getAllStudentsSchema,
  idParamSchema,
  deleteStudentSchema,
};

export type TAdmitStudent = z.infer<typeof admitStudentSchema>['body'];
export type TEnrollExistingStudentValidation = z.infer<
  typeof enrollExistingStudentSchema
>['body'];
export type TUpdateStudent = z.infer<typeof updateStudentSchema>;
export type TGetAllStudents = z.infer<typeof getAllStudentsSchema>['query'];
