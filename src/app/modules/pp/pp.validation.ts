import { z } from 'zod';
import prisma from '../../utils/prisma';

/**
 * Zod schemas for the PP (referral) module.
 *
 * PP is intentionally minimal: `name` is the only required field at
 * create time (no phone, email, or address — the centre works the
 * PP informally). All write schemas are wrapped in `{ body: ... }` /
 * `{ params: ... }` so they slot straight into the project's
 * `validateRequest` middleware.
 */

// ─── Create a PP (POST /pp) ─────────────────────────────────────────
export const createPpSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1, 'Name is required').max(100),
  }),
});

// ─── PP id in URL (DELETE /pp/:id, GET /pp/:id) ─────────────────────
export const ppIdParamSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

// ─── Record a payout (POST /pp/payment) ──────────────────────────────
//
// `studentId` is optional — the admin may pay out a lump sum covering
// multiple students, in which case the row is unattributed and just
// reduces the PP's overall due. When set, the row contributes to
// that student's per-student payout history on the detail page.
//
// `amount` must be > 0. `method` mirrors PpPaymentMethod. `paidAt`
// is optional — service defaults to `new Date()`. `note` is an
// optional free-text field for things like "Q1 settlement".
export const recordPpPaymentSchema = z.object({
  body: z
    .object({
      ppId: z.string().uuid(),
      studentId: z.string().uuid().optional().nullable(),
      amount: z.coerce
        .number()
        .positive('Amount must be greater than 0')
        .max(10_000_000, 'Amount looks too large; double-check the value'),
      method: z.enum(['CASH', 'BKASH', 'NAGAD', 'BANK', 'OTHER']),
      paidAt: z.coerce.date().optional(),
      note: z.string().trim().max(500).optional(),
    })
    // Server-side guard against over-payment. The client already
    // caps the field, but a hand-crafted request (curl, Postman)
    // could otherwise push the per-student "paid" past `ppFee`,
    // which would invert the math on the PP detail dialog
    // ("Due" would go negative). When `studentId` is null this
    // is a lump-sum payout and we don't enforce the cap — the
    // admin may legitimately pay out more than any single
    // student's commission.
    .superRefine(async (data, ctx) => {
      if (!data.studentId) return;
      const [student, paidAgg] = await Promise.all([
        prisma.student.findUnique({
          where: { id: data.studentId },
          select: { ppFee: true, ppId: true },
        }),
        prisma.ppPayment.aggregate({
          where: { ppId: data.ppId, studentId: data.studentId },
          _sum: { amount: true },
        }),
      ]);
      if (!student || student.ppId !== data.ppId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['studentId'],
          message: 'Student is not linked to this PP',
        });
        return;
      }
      const ppFee = student.ppFee == null ? null : Number(student.ppFee);
      if (ppFee == null) return; // no fee set, no cap
      const alreadyPaid = Number(paidAgg._sum.amount ?? 0);
      const cap = ppFee - alreadyPaid;
      if (data.amount > cap) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['amount'],
          message: `Amount can't exceed the student's outstanding commission (৳${cap.toLocaleString()})`,
        });
      }
    }),
});

export const PpValidation = {
  createPpSchema,
  ppIdParamSchema,
  recordPpPaymentSchema,
};

export type TCreatePp = z.infer<typeof createPpSchema>['body'];
export type TRecordPpPayment = z.infer<typeof recordPpPaymentSchema>['body'];