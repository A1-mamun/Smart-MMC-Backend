import dayjs from 'dayjs';
import prisma from '../../utils/prisma';
import { PaymentStatus } from '@prisma/client';

const getAdminDashboardDataFromDB = async () => {
  const now = dayjs();
  const startOfMonth = now.startOf('month').toDate();

  const [
    totalStudents,
    paymentsThisMonthAgg,
    paymentsAllTimeAgg,
    overdueAgg,
    todayAttendance,
    monthAttendance,
    batchGroups,
    recentActivities,
    // Count students whose every active enrollment has status = PAID.
    // Since a single groupBy can't easily express "all per student are PAID",
    // we fetch the (studentId, status) pairs and bucket in JS. This is bounded
    // by the number of active enrollments, not the number of students.
    paidEnrollmentCount,
  ] = await Promise.all([
    prisma.student.count({ where: { isDeleted: false } }),
    prisma.payment.aggregate({
      where: { isDeleted: false, paidAt: { gte: startOfMonth } },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.payment.aggregate({
      where: { isDeleted: false, paidAt: { not: null } },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.payment.count({
      where: { isDeleted: false, dueDate: { lt: now.toDate() }, paidAt: null },
    }),
    prisma.attendance.count({
      where: { date: now.startOf('day').toDate() },
    }),
    prisma.attendance.count({
      where: { date: { gte: startOfMonth } },
    }),
    prisma.studentBatch.groupBy({
      by: ['hscBatch', 'batchDay', 'batchTime'],
      where: { isDeleted: false, student: { isDeleted: false } },
      _count: { studentId: true },
    }),
    prisma.activityLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    prisma.studentCourse.count({
      where: { isDeleted: false, status: PaymentStatus.PAID },
    }),
  ]);

  // Get all active enrollments with their persisted status. Use that to
  // compute per-student payment-status counts (PAID, PARTIAL, PENDING).
  const activeEnrollments = await prisma.studentCourse.findMany({
    where: { isDeleted: false, student: { isDeleted: false } },
    select: { studentId: true, status: true },
  });

  // Track which student has at least one active enrollment and the set of
  // statuses across their enrollments. Then derive their overall bucket.
  const studentStatusSets = new Map<string, Set<string>>();
  for (const e of activeEnrollments) {
    if (!studentStatusSets.has(e.studentId)) {
      studentStatusSets.set(e.studentId, new Set());
    }
    studentStatusSets.get(e.studentId)!.add(e.status);
  }

  let fullyPaidCount = 0;
  let partialCount = 0;
  let pendingCount = 0;
  for (const statuses of studentStatusSets.values()) {
    if (statuses.size === 1 && statuses.has(PaymentStatus.PAID)) {
      fullyPaidCount += 1;
    } else if (statuses.has(PaymentStatus.PARTIAL)) {
      partialCount += 1;
    } else {
      pendingCount += 1;
    }
  }

  return {
    cards: {
      totalStudents,
      fullyPaidStudents: fullyPaidCount,
      partialPaymentStudents: partialCount,
      pendingPaymentStudents: pendingCount,
      overdueRecords: overdueAgg,
      collectedThisMonth: Number(paymentsThisMonthAgg._sum.amount || 0),
      collectedAllTime: Number(paymentsAllTimeAgg._sum.amount || 0),
      todayAttendance,
      monthAttendance,
    },
    paidEnrollmentCount,
    recentActivities,
    batchGroups: batchGroups.map((b) => ({
      hscBatch: b.hscBatch,
      batchDay: b.batchDay,
      batchTime: b.batchTime,
      studentCount: b._count.studentId,
    })),
    generatedAt: new Date().toISOString(),
  };
};

const getStudentDashboardDataFromDB = async (userId: string) => {
  const student = await prisma.student.findUnique({
    where: { userId },
    include: {
      user: true,
      studentCourses: {
        where: { isDeleted: false },
        include: { course: true, payments: { where: { isDeleted: false } } },
      },
      attendance: {
        orderBy: { date: 'desc' },
        take: 10,
      },
    },
  });
  if (!student) return null;

  const startOfMonth = dayjs().startOf('month').toDate();
  const attendanceThisMonth = await prisma.attendance.count({
    where: {
      studentId: student.id,
      date: { gte: startOfMonth },
    },
  });

  const totalDue = student.studentCourses.reduce((sum, sc) => {
    const paid = sc.payments.reduce((p, pay) => p + Number(pay.amount), 0);
    return sum + Math.max(0, Number(sc.course.fee) - paid);
  }, 0);

  return {
    profile: {
      studentId: student.user.studentId,
      name: student.user.name,
      nickname: student.user.nickname,
      mobile: student.mobile,
    },
    courses: student.studentCourses.map((sc) => {
      const paid = sc.payments.reduce((p, pay) => p + Number(pay.amount), 0);
      const fee = Number(sc.course.fee);
      return {
        id: sc.id,
        courseName: sc.course.name,
        fee,
        paid,
        due: Math.max(0, fee - paid),
        isCompleted: sc.isCompleted,
        status: sc.status,
      };
    }),
    attendance: {
      recent: student.attendance,
      thisMonth: attendanceThisMonth,
    },
    totalDue,
  };
};

export const DashboardService = {
  getAdminDashboardDataFromDB,
  getStudentDashboardDataFromDB,
};