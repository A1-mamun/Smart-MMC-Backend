import { z } from 'zod';

const attendanceMethods = ['NFC', 'MANUAL', 'ADMIN'] as const;

const checkInSchema = z.object({
  body: z.object({
    studentId: z.string().min(1),
    deviceId: z.string().max(100).optional(),
  }),
});

const manualCheckInSchema = z.object({
  body: z.object({
    studentId: z.string().uuid(),
    date: z.coerce.date().optional(),
  }),
});

const getStudentAttendanceSchema = z.object({
  params: z.object({ studentId: z.string().uuid() }),
  query: z.object({
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
  }),
});

const getTodaySchema = z.object({
  query: z.object({
    batchDay: z.string().optional(),
    batchTime: z.string().optional(),
    hscBatch: z.string().optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
});

const idParamSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

const deviceSecretSchema = z.object({
  headers: z.object({
    'x-device-secret': z.string().min(1),
  }),
});

export const AttendanceValidation = {
  checkInSchema,
  manualCheckInSchema,
  getStudentAttendanceSchema,
  getTodaySchema,
  idParamSchema,
  deviceSecretSchema,
};

export type TCheckIn = z.infer<typeof checkInSchema>['body'];
export type TManualCheckIn = z.infer<typeof manualCheckInSchema>['body'];
export type TGetStudentAttendance = z.infer<typeof getStudentAttendanceSchema>;
export type TGetToday = z.infer<typeof getTodaySchema>['query'];