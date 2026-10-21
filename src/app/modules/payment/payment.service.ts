import httpStatus from 'http-status';
import { Prisma } from '@prisma/client';
import { JwtPayload } from 'jsonwebtoken';
import prisma from '../../utils/prisma';
import AppError from '../../errors/AppError';
import { TRecordPayment, TUpdatePayment, TGetAllPayments, TGetDuePayments } from './payment.validation';
import calculatePagination from '../../utils/calculatePagination';
import { clearPaymentCache } from '../../utils/clearCache';
import { sendViaBulkSmsBd, explainUpstreamCode } from '../../utils/smsGateway';
import { toIntl } from '../../utils/phone';

/**
 * Build the body of the course-fee confirmation SMS. Kept in one place
 * so the wording is easy to tweak without hunting through service
 * code. The student name is the User.name on the auth record — the
 * same identifier used everywhere else in the admin UI.
 *
 * Two variants:
 *   - Full settlement (isFullyPaid = true):
 *       "Dear Rahim, your HSC 1st Year course fee of ৳12000 has
 *        been received. Thank you. - Smart MMC"
 *   - Partial / in-flight payment (isFullyPaid = false):
 *       "Dear Rahim, we received your partial payment of ৳5000
 *        for HSC 1st Year. Thank you. - Smart MMC"
 *
 * The partial wording is deliberately honest — the student still
 * owes the balance, so we don't claim the "course fee has been
 * received" the way the full-settlement variant does.
 */
const buildPaymentConfirmationMessage = (params: {
  studentName: string;
  courseName: string;
  amount: number;
  isFullyPaid: boolean;
}): string =>
  params.isFullyPaid
    ? `Dear ${params.studentName}, your ${params.courseName} course fee of ৳${params.amount} has been received. Thank you. - Smart MMC`
    : `Dear ${params.studentName}, we received your partial payment of ৳${params.amount} for ${params.courseName}. Thank you. - Smart MMC`;

/**
 * Fire-and-forget payment confirmation SMS. Intentionally swallows
 * every error so a misconfigured gateway or a bad mobile number
 * never breaks the payment-recording flow (the cash is already
 * in the books — the SMS is a courtesy, not a precondition).
 *
 * The SmsLog row (whether SUCCESS or FAILED) is still written so
 * the audit trail reflects what the system attempted. Same status
 * taxonomy as the manual SMS module: SUCCESS, FAILED.
 *
 * `sentById` is set to the admin who recorded the payment so the
 * log row's "sent by" column points at the human action that
 * triggered the auto-message — useful for audit when an admin
 * later asks "who paid student X today?".
 */
const sendPaymentConfirmationSms = async (params: {
  studentId: string;
  studentName: string;
  mobile: string;
  courseName: string;
  amount: number;
  isFullyPaid: boolean;
  paymentId: string;
  sentById: string;
}): Promise<void> => {
  const intl = toIntl(params.mobile);
  if (!intl) {
    // The student's mobile is malformed — log it so an admin can
    // see why no SMS went out, but never throw.
    await prisma.activityLog.create({
      data: {
        actorId: params.sentById,
        actorRole: 'ADMIN',
        action: 'SMS_SKIPPED',
        entityType: 'Payment',
        entityId: params.paymentId,
        description: `Payment confirmation SMS skipped for ${params.studentName}: mobile "${params.mobile}" is not a valid BD number`,
        metadata: {
          reason: 'invalid_mobile',
          rawMobile: params.mobile,
          studentId: params.studentId,
        },
      },
    });
    return;
  }

  const message = buildPaymentConfirmationMessage({
    studentName: params.studentName,
    courseName: params.courseName,
    amount: params.amount,
    isFullyPaid: params.isFullyPaid,
  });

  let result: Awaited<ReturnType<typeof sendViaBulkSmsBd>>;
  try {
    result = await sendViaBulkSmsBd({ numbers: [intl], message });
  } catch (err) {
    // Gateway is not configured at all (no API key in .env) — the
    // smsGateway helper throws rather than returning an error code.
    // Persist a FAILED log so the audit trail still reflects the
    // attempt and the admin can see why no message went out.
    await prisma.smsLog.create({
      data: {
        recipients: intl,
        message,
        status: 'FAILED',
        upstreamCode: 'GATEWAY_UNCONFIGURED',
        errorMsg: err instanceof Error ? err.message : 'SMS gateway unavailable',
        count: 0,
        mode: 'PAYMENT_CONFIRMATION',
        sentById: params.sentById,
      },
    });
    return;
  }

  const status: 'SUCCESS' | 'FAILED' = result.ok ? 'SUCCESS' : 'FAILED';

  await prisma.smsLog.create({
    data: {
      recipients: intl,
      message,
      status,
      upstreamCode: result.code,
      errorMsg: result.ok ? null : explainUpstreamCode(result.code),
      count: result.ok ? result.count : 0,
      mode: 'PAYMENT_CONFIRMATION',
      sentById: params.sentById,
    },
  });

  await prisma.activityLog.create({
    data: {
      actorId: params.sentById,
      actorRole: 'ADMIN',
      action: result.ok ? 'PAYMENT_CONFIRMATION_SMS_SENT' : 'PAYMENT_CONFIRMATION_SMS_FAILED',
      entityType: 'Payment',
      entityId: params.paymentId,
      description: result.ok
        ? `Payment confirmation SMS sent to ${params.studentName} (${params.isFullyPaid ? 'full' : 'partial'} settlement)`
        : `Payment confirmation SMS failed for ${params.studentName}: ${explainUpstreamCode(result.code)}`,
      metadata: {
        studentId: params.studentId,
        amount: params.amount,
        courseName: params.courseName,
        isFullyPaid: params.isFullyPaid,
        upstreamCode: result.code,
      },
    },
  });
};

const recordPaymentToDB = async (payload: TRecordPayment, user: JwtPayload) => {
  const student = await prisma.student.findUnique({ where: { id: payload.studentId } });
  if (!student) throw new AppError(httpStatus.NOT_FOUND, 'Student not found');

  if (payload.studentCourseId) {
    const enrollment = await prisma.studentCourse.findUnique({
      where: { id: payload.studentCourseId },
    });
    if (!enrollment || enrollment.studentId !== payload.studentId) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'Enrollment does not belong to this student',
      );
    }
  }

  // Closure-scoped flag so the post-commit SMS dispatch can read
  // the freshly recomputed enrollment status without a second DB
  // round-trip and without stashing a transient field on the
  // returned Payment row (which would leak into the public
  // response). Typed as a 3-state union (not just `boolean`) so
  // TS doesn't collapse the `=== 'PAID'` / `=== 'PARTIAL'`
  // checks below into "always false" — the flag is only ever
  // flipped inside the conditional `if (enrollment)` block, and
  // we want a clear "did the status actually move?" signal.
  let enrollmentNowPaid: boolean | null = null;
  let enrollmentNowPartial: boolean | null = null;

  const result = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        studentId: payload.studentId,
        studentCourseId: payload.studentCourseId,
        amount: new Prisma.Decimal(payload.amount),
        method: payload.method,
        transactionId: payload.transactionId,
        senderNumber: payload.senderNumber,
        note: payload.note,
        paidAt: payload.paidAt || new Date(),
        dueDate: payload.dueDate,
        collectedBy: user.userId,
      },
      include: {
        student: { include: { user: true } },
        studentCourse: { include: { course: true } },
      },
    });

    // Recompute and persist the StudentCourse.status based on the new total
    // paid vs the course fee. Paid → PAID, some paid → PARTIAL, none → PENDING.
    // If the caller passed an overrideStatus we apply it verbatim instead —
    // the Payment.amount itself is unchanged so the math is still honest.
    if (payment.studentCourseId) {
      const enrollment = await tx.studentCourse.findUnique({
        where: { id: payment.studentCourseId },
        include: { course: true, payments: { where: { isDeleted: false } } },
      });
      if (enrollment) {
        let status: 'PENDING' | 'PARTIAL' | 'PAID';
        if (payload.overrideStatus) {
          status = payload.overrideStatus;
        } else {
          const fee = Number(enrollment.course.fee);
          const totalPaid = enrollment.payments.reduce(
            (sum, p) => sum + Number(p.amount),
            0,
          );
          status =
            totalPaid >= fee
              ? 'PAID'
              : totalPaid > 0
              ? 'PARTIAL'
              : 'PENDING';
        }
        await tx.studentCourse.update({
          where: { id: enrollment.id },
          data: { status },
        });
        // Capture for the post-commit SMS check. We use the
        // computed status (not a fresh DB read) so a manual
        // override to PAID is also eligible for the SMS — the
        // admin explicitly marked the enrollment as settled,
        // and the student should still get the courtesy
        // notification. PARTIAL captures the "in-flight" state
        // so a partial payment also fires the SMS (the user
        // confirmed partial payments should notify too).
        enrollmentNowPaid = status === 'PAID';
        enrollmentNowPartial = status === 'PARTIAL';
      }
    }

    await tx.activityLog.create({
      data: {
        actorId: user.userId,
        actorRole: user.role as 'SUPER_ADMIN' | 'ADMIN',
        action: 'PAYMENT_RECORDED',
        entityType: 'Payment',
        entityId: payment.id,
        description: `Payment of ৳${payload.amount} by ${payment.student.user.name}`,
        metadata: {
          studentId: payload.studentId,
          amount: payload.amount,
          method: payload.method,
        },
      },
    });

    return payment;
  });

  await clearPaymentCache();

  // Fire the confirmation SMS AFTER the transaction commits and
  // the cache is cleared, so the student's mobile is hit only
  // when the books genuinely reflect a recorded payment. The
  // helper is fully fire-and-forget: any gateway / network /
  // invalid-number failure is logged to SmsLog + ActivityLog but
  // never bubbles up to the caller — the payment is already
  // safely recorded, the SMS is just a courtesy.
  //
  // Triggers (per the user's request — "after successful payment
  // of student course fee" applies to every settled payment, not
  // only the ones that fully pay off the course):
  //   - Enrollment is now PAID (full settlement, either auto
  //     from the math or a manual `overrideStatus: 'PAID'`), or
  //   - Enrollment is now PARTIAL (in-flight — some of the fee
  //     is paid, the rest is still outstanding). The user
  //     confirmed partial payments should also notify the
  //     student.
  //
  // Skipped when:
  //   - The payment isn't tied to any enrollment (a generic
  //     student-level payment that doesn't belong to a course —
  //     no course context to put in the SMS body).
  //   - The recomputed status is still PENDING (the payment
  //     hit a defensive branch where the amount didn't move
  //     the needle — a 0-amount record shouldn't spam the
  //     student). This is the safety net for malformed
  //     payloads; the normal path always moves out of PENDING
  //     when an amount > 0 is recorded.
  //   - The student has no enrollments resolved in the result
  //     (defensive — should be impossible after the create).
  const shouldSendConfirmation =
    !!result.studentCourse &&
    (enrollmentNowPaid === true || enrollmentNowPartial === true);

  if (shouldSendConfirmation) {
    // Look up the mobile fresh — the `include` on the create
    // payload above already returned `student` with `user`, so
    // we technically have it, but a dedicated lookup here keeps
    // the helper signature self-contained and the call site
    // readable. The `user.name` is the canonical display name
    // (same identifier used in the admin UI / receipts).
    const studentWithUser = await prisma.student.findUnique({
      where: { id: payload.studentId },
      include: { user: true },
    });
    if (studentWithUser) {
      await sendPaymentConfirmationSms({
        studentId: result.studentId,
        studentName: studentWithUser.user.name,
        mobile: studentWithUser.mobile,
        courseName: result.studentCourse!.course.name,
        amount: Number(result.amount),
        // Tells the message builder whether to word the body
        // as a full settlement ("course fee ... has been
        // received") or an in-flight payment ("partial
        // payment ... has been received"). Keeps the wording
        // honest when the student still owes the balance.
        isFullyPaid: enrollmentNowPaid === true,
        paymentId: result.id,
        sentById: user.userId,
      });
    }
  }

  return result;
};

const getAllPaymentsFromDB = async (filters: TGetAllPayments) => {
  const { page, limit, skip, sortBy, sortOrder } = calculatePagination(filters);
  const where: Prisma.PaymentWhereInput = { isDeleted: false };
  if (filters.studentId) where.studentId = filters.studentId;
  if (filters.method) where.method = filters.method;
  if (filters.paid === true) where.paidAt = { not: null };
  if (filters.paid === false) where.paidAt = null;
  if (filters.startDate || filters.endDate) {
    where.paidAt = {
      ...((filters.paid === true && { not: null }) || {}),
      ...(filters.startDate ? { gte: filters.startDate } : {}),
      ...(filters.endDate ? { lte: filters.endDate } : {}),
    };
  }

  if (filters.courseId) {
    where.studentCourse = { courseId: filters.courseId };
  }

  // Free-text search: match student name, BD-code, or mobile. `name` and
  // `studentId` live on `User` (the auth record), `mobile` is on Student.
  // All three are reachable via a single `student.user` traversal.
  //
  // We can't simply set `where.student = { OR: [...] }` when `courseId`
  // is also set — that would create two relation paths into the Student
  // model (one from `Payment.student`, one from
  // `Payment.studentCourse.student`), which Prisma doesn't allow without
  // explicit AND-merging. When `courseId` is set we nest the search under
  // `studentCourse.student` so the filter stays on a single relation
  // path; otherwise we put the search at the top-level `student` slot.
  //
  // `mode: 'insensitive'` is mapped to Postgres `ILIKE` by Prisma.
  if (filters.searchTerm) {
    const searchFilter: Prisma.PaymentWhereInput['student'] = {
      OR: [
        { user: { name: { contains: filters.searchTerm, mode: 'insensitive' } } },
        // Mobile doubles as the login identifier now — searchable too
        // so admins can find a student / payment by phone number.
        // The dropped `User.studentId` is replaced here.
        { user: { mobile: { contains: filters.searchTerm, mode: 'insensitive' } } },
        { mobile: { contains: filters.searchTerm, mode: 'insensitive' } },
      ],
    };
    if (where.studentCourse) {
      // Nest the search filter alongside `courseId` so it ANDs with it.
      where.studentCourse = {
        ...((where.studentCourse as object) ?? {}),
        student: searchFilter,
      } as Prisma.PaymentWhereInput['studentCourse'];
    } else {
      where.student = searchFilter;
    }
  }

  const orderBy: Prisma.PaymentOrderByWithRelationInput = sortBy
    ? ({ [sortBy]: sortOrder } as Prisma.PaymentOrderByWithRelationInput)
    : { createdAt: 'desc' };

  const [data, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      skip,
      take: limit,
      orderBy,
      include: {
        student: { include: { user: true } },
        studentCourse: { include: { course: true } },
      },
    }),
    prisma.payment.count({ where }),
  ]);

  return { data, meta: { page, limit, total } };
};

const getStudentPaymentsFromDB = async (studentId: string) => {
  const payments = await prisma.payment.findMany({
    where: { studentId, isDeleted: false },
    include: { studentCourse: { include: { course: true } } },
    orderBy: { createdAt: 'desc' },
  });

  const enrollments = await prisma.studentCourse.findMany({
    where: { studentId, isDeleted: false },
    include: { course: true },
  });

  const summary = enrollments.map((e) => {
    const totalPaid = payments
      .filter((p) => p.studentCourseId === e.id)
      .reduce((sum, p) => sum + Number(p.amount), 0);
    return {
      courseId: e.courseId,
      courseName: e.course.name,
      fee: Number(e.course.fee),
      paid: totalPaid,
      due: Math.max(0, Number(e.course.fee) - totalPaid),
    };
  });

  return { payments, summary };
};

const getDuePaymentsFromDB = async (filters: TGetDuePayments = {}) => {
  const enrollments = await prisma.studentCourse.findMany({
    where: { isDeleted: false },
    include: {
      course: true,
      student: { include: { user: true } },
      payments: { where: { isDeleted: false } },
    },
  });

  const dueRecords = enrollments
    .map((e) => {
      const paid = e.payments.reduce((s, p) => s + Number(p.amount), 0);
      const fee = Number(e.course.fee);
      const due = fee - paid;
      // Persisted enrollment status (PAID/PARTIAL/PENDING). Honors manual
      // overrides recorded via the record-payment overrideStatus field.
      const persistedStatus = e.status as 'PENDING' | 'PARTIAL' | 'PAID';
      return {
        studentId: e.studentId,
        // The StudentCourse id is what the RecordPaymentModal needs to bind
        // a payment to a specific enrollment (we look up by enrollment id,
        // not course id, so a student enrolled in two batches of the same
        // course still gets the right one preselected).
        studentCourseId: e.id,
        studentName: e.student.user.name,
        // Per-enrollment printable ID (`StudentCourse.studentCourseId`).
        // Replaces the dropped `User.studentId` for receipt display —
        // scope is per enrollment, not per user.
        studentUserId: e.studentCourseId ?? e.student.userId,
        // Surface the student's mobile so the frontend search can match
        // it (consistent with /payment's search dimensions). Was not
        // previously exposed because the original Due tab had no search.
        studentMobile: e.student.mobile,
        courseId: e.courseId,
        courseName: e.course.name,
        totalFee: fee,
        paid,
        due: Math.max(0, due),
        isFullyPaid: due <= 0,
        // Surface the persisted enrollment status so callers can also
        // filter client-side if they need to.
        status: persistedStatus,
      };
    })
    /*
     * Filter to "actually owes money" using either the persisted
     * StudentCourse.status (respects manual overrides) OR the computed
     * amount due. An enrollment manually marked PAID drops out even when
     * `fee - paid` is still positive; a not-yet-paid enrollment drops
     * out only when the amount has actually been settled in the table.
     */
    .filter((r) => r.status !== 'PAID' && r.due > 0);

  // Free-text search over name, BD-code, and mobile. Comparing in memory
  // here is fine — the in-memory `dueRecords` list is already bounded by
  // the cohort size (one row per enrollment) and the toLowerCase pass is
  // O(n). Pushing this to a SQL `WHERE` would require restructuring the
  // existing map+filter pipeline (the per-enrollment computation reads
  // `payments[]` to derive `due`).
  //
  // The case-insensitive comparison matches `getAllPaymentsFromDB`'s
  // `mode: 'insensitive'` behaviour so the two tabs' search affordances
  // feel identical to admins.
  const filtered = filters.searchTerm
    ? dueRecords.filter((r) => {
        const q = filters.searchTerm!.toLowerCase();
        return (
          r.studentName.toLowerCase().includes(q) ||
          r.studentUserId.toLowerCase().includes(q) ||
          r.studentMobile.toLowerCase().includes(q)
        );
      })
    : dueRecords;

  const totalDueAmount = filtered.reduce((s, r) => s + r.due, 0);

  return {
    records: filtered,
    summary: {
      // Count of distinct students *in the filtered result*, not the
      // full unfiltered list. This matches what the admin sees on
      // screen and avoids the "shows 30, but only 5 are visible"
      // discrepancy the previous behaviour would produce once search
      // was added.
      totalDueStudents: new Set(filtered.map((r) => r.studentId)).size,
      totalDueAmount,
    },
  };
};

const updatePaymentInDB = async (id: string, payload: TUpdatePayment['body']) => {
  const existing = await prisma.payment.findUnique({ where: { id } });
  if (!existing) throw new AppError(httpStatus.NOT_FOUND, 'Payment not found');

  const data: Prisma.PaymentUpdateInput = {};
  if (payload.amount !== undefined) data.amount = new Prisma.Decimal(payload.amount);
  if (payload.method) data.method = payload.method;
  if (payload.transactionId !== undefined) data.transactionId = payload.transactionId;
  if (payload.senderNumber !== undefined) data.senderNumber = payload.senderNumber;
  if (payload.note !== undefined) data.note = payload.note;
  if (payload.paidAt !== undefined) data.paidAt = payload.paidAt;
  if (payload.dueDate !== undefined) data.dueDate = payload.dueDate;

  const updated = await prisma.payment.update({
    where: { id },
    data,
    include: { student: { include: { user: true } } },
  });
  await clearPaymentCache();
  return updated;
};

const deletePaymentFromDB = async (id: string, user: JwtPayload) => {
  const existing = await prisma.payment.findUnique({ where: { id } });
  if (!existing) throw new AppError(httpStatus.NOT_FOUND, 'Payment not found');
  await prisma.payment.update({
    where: { id },
    data: { isDeleted: true, deletedAt: new Date(), deletedBy: user.userId },
  });
  await clearPaymentCache();
  return null;
};

export const PaymentService = {
  recordPaymentToDB,
  getAllPaymentsFromDB,
  getStudentPaymentsFromDB,
  getDuePaymentsFromDB,
  updatePaymentInDB,
  deletePaymentFromDB,
};