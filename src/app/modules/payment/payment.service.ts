import httpStatus from 'http-status';
import { Prisma } from '@prisma/client';
import { JwtPayload } from 'jsonwebtoken';
import prisma from '../../utils/prisma';
import AppError from '../../errors/AppError';
import { TRecordPayment, TUpdatePayment, TGetAllPayments } from './payment.validation';
import calculatePagination from '../../utils/calculatePagination';
import { clearPaymentCache } from '../../utils/clearCache';

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
    if (payment.studentCourseId) {
      const enrollment = await tx.studentCourse.findUnique({
        where: { id: payment.studentCourseId },
        include: { course: true, payments: { where: { isDeleted: false } } },
      });
      if (enrollment) {
        const fee = Number(enrollment.course.fee);
        const totalPaid = enrollment.payments.reduce(
          (sum, p) => sum + Number(p.amount),
          0,
        );
        const status: 'PENDING' | 'PARTIAL' | 'PAID' =
          totalPaid >= fee
            ? 'PAID'
            : totalPaid > 0
            ? 'PARTIAL'
            : 'PENDING';
        await tx.studentCourse.update({
          where: { id: enrollment.id },
          data: { status },
        });
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

const getDuePaymentsFromDB = async () => {
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
      return {
        studentId: e.studentId,
        studentName: e.student.user.name,
        studentUserId: e.student.user.studentId,
        courseId: e.courseId,
        courseName: e.course.name,
        totalFee: fee,
        paid,
        due: Math.max(0, due),
        isFullyPaid: due <= 0,
      };
    })
    .filter((r) => r.due > 0);

  const totalDueAmount = dueRecords.reduce((s, r) => s + r.due, 0);

  return {
    records: dueRecords,
    summary: {
      totalDueStudents: new Set(dueRecords.map((r) => r.studentId)).size,
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