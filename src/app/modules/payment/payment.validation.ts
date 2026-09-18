import { z } from 'zod';

const paymentMethods = ['CASH', 'BKASH', 'NAGAD', 'BANK', 'OTHER'] as const;
const paymentStatuses = ['PENDING', 'PARTIAL', 'PAID'] as const;

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
    /*
     * Optional status override for the resulting StudentCourse record.
     * When omitted, the service keeps its current auto-tracking behavior:
     *   paid === fee → PAID, paid > 0 → PARTIAL, paid === 0 → PENDING.
     * When provided, the chosen status is applied verbatim (e.g. staff can
     * mark a partial payment as PAID for reporting).
     * Only affects the StudentCourse.status — the Payment.amount itself
     * remains unchanged so bookkeeping stays honest.
     */
    overrideStatus: z.enum(paymentStatuses).optional(),
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
    // Free-text search across student name, student ID (BD-code), and
    // mobile. Case-insensitive `contains` matches live on Student/User
    // rows via the existing Prisma `where.student` relation. Empty
    // strings are rejected by the min(1) check so callers can pass
    // `searchTerm: ''` safely through clients that always send the field.
    searchTerm: z.string().trim().min(1).max(100).optional(),
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

// `/payment/due` accepts a single optional search term that filters the
// resulting records after the service computes them. Same matching
// strategy as `getAllPaymentsSchema.searchTerm` (student name, BD-code,
// mobile) so the two tabs behave consistently — the service does the
// case-insensitive comparison in-memory because the records list is
// already resolved at this point (the existing `enrollments.map(...)`
// pattern returns materialized rows).
const getDuePaymentsSchema = z.object({
  query: z.object({
    searchTerm: z.string().trim().min(1).max(100).optional(),
  }),
});

export const PaymentValidation = {
  recordPaymentSchema,
  updatePaymentSchema,
  getAllPaymentsSchema,
  getDuePaymentsSchema,
  idParamSchema,
  studentIdParamSchema,
};

export type TRecordPayment = z.infer<typeof recordPaymentSchema>['body'];
export type TUpdatePayment = z.infer<typeof updatePaymentSchema>;
export type TGetAllPayments = z.infer<typeof getAllPaymentsSchema>['query'];
export type TGetDuePayments = z.infer<typeof getDuePaymentsSchema>['query'];