import { z } from 'zod';

const paymentMethods = ['CASH', 'BKASH', 'NAGAD', 'BANK', 'OTHER'] as const;

const recordPaymentSchema = z.object({
  body: z.object({
    studentId: z.string().uuid(),
    studentCourseId: z.string().uuid().optional(),
    amount: z.coerce.number().positive('Amount must be positive'),
    method: z.enum(paymentMethods),
    transactionId: z.string().max(100).optional(),
    senderNumber: z.string().max(20).optional(),
    note: z.string().max(500).optional(),
    paidAt: z.coerce.date().optional(),
    dueDate: z.coerce.date().optional(),
  }),
});

const updatePaymentSchema = z.object({
  body: z.object({
    amount: z.coerce.number().positive().optional(),
    method: z.enum(paymentMethods).optional(),
    transactionId: z.string().max(100).optional(),
    senderNumber: z.string().max(20).optional(),
    note: z.string().max(500).optional(),
    paidAt: z.coerce.date().optional(),
    dueDate: z.coerce.date().optional(),
  }),
  params: z.object({ id: z.string().uuid() }),
});

const getAllPaymentsSchema = z.object({
  query: z.object({
    studentId: z.string().uuid().optional(),
    courseId: z.string().uuid().optional(),
    method: z.enum(paymentMethods).optional(),
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
    paid: z.coerce.boolean().optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
  }),
});

const idParamSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

const studentIdParamSchema = z.object({
  params: z.object({ studentId: z.string().uuid() }),
});

export const PaymentValidation = {
  recordPaymentSchema,
  updatePaymentSchema,
  getAllPaymentsSchema,
  idParamSchema,
  studentIdParamSchema,
};

export type TRecordPayment = z.infer<typeof recordPaymentSchema>['body'];
export type TUpdatePayment = z.infer<typeof updatePaymentSchema>;
export type TGetAllPayments = z.infer<typeof getAllPaymentsSchema>['query'];