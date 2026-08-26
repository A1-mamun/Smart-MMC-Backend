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
    bloodGroup: z.enum(bloodGroups),
    fatherName: z.string().min(2).max(100),
    fatherOccupation: z.string().min(2).max(100),
    fatherMobile: z.string().regex(phoneRegex, 'Invalid BD mobile number'),
    motherName: z.string().min(2).max(100),
    motherOccupation: z.string().min(2).max(100),
    motherMobile: z.string().regex(phoneRegex, 'Invalid BD mobile number'),
    addressVillage: z.string().min(1).max(200),
    addressPostOffice: z.string().min(1).max(100),
    addressUpozila: z.string().min(1).max(100),
    addressDistrict: z.string().min(1).max(100),
    sscInstitute: z.string().min(1).max(200),
    sscBoard: z.enum(boards),
    sscPassingYear: z.coerce.number().int().min(2010).max(new Date().getFullYear()),
    sscGpa: z.coerce.number().min(0).max(5),
    courseId: z.string().uuid('Select a course'),
    batchDayId: z.string().uuid('Select a batch day'),
    batchTime: z
      .string()
      .trim()
      .regex(batchTimeRegex, 'Time must be in "h:mm AM/PM" format (e.g. 7:00 AM)'),
  }),
});

const updateStudentSchema = z.object({
  body: z.object({
    name: z.string().min(2).max(100).optional(),
    nickname: z.string().max(50).optional(),
    college: z.string().max(200).optional(),
    mobile: z.string().regex(phoneRegex).optional(),
    bloodGroup: z.enum(bloodGroups).optional(),
    fatherName: z.string().min(2).max(100).optional(),
    fatherOccupation: z.string().min(2).max(100).optional(),
    fatherMobile: z.string().regex(phoneRegex).optional(),
    motherName: z.string().min(2).max(100).optional(),
    motherOccupation: z.string().min(2).max(100).optional(),
    motherMobile: z.string().regex(phoneRegex).optional(),
    addressVillage: z.string().min(1).max(200).optional(),
    addressPostOffice: z.string().min(1).max(100).optional(),
    addressUpozila: z.string().min(1).max(100).optional(),
    addressDistrict: z.string().min(1).max(100).optional(),
    sscInstitute: z.string().min(1).max(200).optional(),
    sscBoard: z.enum(boards).optional(),
    sscPassingYear: z.coerce.number().int().min(2010).max(new Date().getFullYear()).optional(),
    sscGpa: z.coerce.number().min(0).max(5).optional(),
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
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
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
  updateStudentSchema,
  getAllStudentsSchema,
  idParamSchema,
  deleteStudentSchema,
};

export type TAdmitStudent = z.infer<typeof admitStudentSchema>['body'];
export type TUpdateStudent = z.infer<typeof updateStudentSchema>;
export type TGetAllStudents = z.infer<typeof getAllStudentsSchema>['query'];
