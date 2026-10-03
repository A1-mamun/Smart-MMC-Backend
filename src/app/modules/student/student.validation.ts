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
    name: z.string().min(2).max(100),
    nickname: z.string().max(50).optional(),
    college: z.string().max(200).optional(),
    mobile: z.string().regex(phoneRegex, 'Invalid BD mobile number'),
    // Optional — admins frequently admit students without yet having
    // blood-group info on file.
    bloodGroup: z.enum(bloodGroups).optional().nullable(),
    // Father block: required (name + occupation + mobile).
    fatherName: z.string().min(2).max(100),
    fatherOccupation: z.string().min(2).max(100),
    fatherMobile: z.string().regex(phoneRegex, 'Invalid BD mobile number'),
    // Mother block: optional — single-parent / missing-info households.
    motherName: z.string().min(2).max(100).optional().nullable(),
    motherOccupation: z.string().max(100).optional().nullable(),
    motherMobile: z
      .string()
      .regex(phoneRegex, 'Invalid BD mobile number')
      .optional()
      .nullable()
      .or(z.literal('')),
    // Address: only Upazila + District are required. Village / Post Office
    // are common to be unknown at admit time (urban students especially).
    addressVillage: z.string().max(200).optional().nullable().or(z.literal('')),
    addressPostOffice: z.string().max(100).optional().nullable().or(z.literal('')),
    addressUpozila: z.string().min(1).max(100),
    addressDistrict: z.string().min(1).max(100),
    // SSC: institute required; board / year / GPA often filled in later
    // once the student brings their certificate / testimonial.
    sscInstitute: z.string().min(1).max(200),
    sscBoard: z.enum(boards).optional().nullable(),
    sscPassingYear: z.coerce
      .number()
      .int()
      .min(2010)
      .max(new Date().getFullYear())
      .optional()
      .nullable(),
    sscGpa: z.coerce.number().min(0).max(5).optional().nullable(),
    courseId: z.string().uuid('Select a course'),
    batchDayId: z.string().uuid('Select a batch day'),
    batchTime: z
      .string()
      .trim()
      .regex(batchTimeRegex, 'Time must be in "h:mm AM/PM" format (e.g. 7:00 AM)'),
  }),
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
  }),
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
  }),
  params: z.object({ id: z.string().uuid() }),
});

const getAllStudentsSchema = z.object({
  query: z.object({
    searchTerm: z.string().optional(),
    hscBatch: z.enum(hscBatches).optional(),
    courseId: z.string().uuid().optional(),
    batchDay: z.string().optional(),
    batchDayId: z.string().uuid().optional(),
    batchTime: z.string().optional(),
    district: z.string().optional(),
    // SMS scenario filters — all additive (AND-combined) with the filters
    // above. `classDate` is an ISO date; we resolve it to a weekday name
    // server-side and match against BatchDay.days[]. `classTime` narrows
    // the match to a single time slot (e.g. "3:00 PM"). `scenarioCourses`
    // is a CSV of course UUIDs used by the bulk-SMS "course-wise" picker.
    // `hasDue` / `activeCoursesOnly` are the dedicated "due payments" and
    // "active courses" scenarios.
    classDate: z.coerce.date().optional(),
    classTime: z.string().optional(),
    scenarioCourses: z.string().optional(),
    hasDue: z.coerce.boolean().optional(),
    activeCoursesOnly: z.coerce.boolean().optional(),
    // Free-vs-paid segregation. Paid dashboards pass `false` to hide
    // free-class accounts; the marketer view passes `true`; leaving it
    // unset returns everyone.
    isFreeAccount: z.coerce.boolean().optional(),
    // ISO yyyy-mm-dd — server resolves to "students enrolled in a
    // class on this weekday MINUS students with an Attendance row on
    // this date". Used by the absent-warning SMS picker on
    // /dashboard/sms. Combines additively with the rest of the
    // filter chain.
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
