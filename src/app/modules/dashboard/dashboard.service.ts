import dayjs from 'dayjs';
import prisma from '../../utils/prisma';

const getAdminDashboardDataFromDB = async () => {
  const now = dayjs();
  const startOfMonth = now.startOf('month').toDate();
  const startOfLastMonth = now.subtract(1, 'month').startOf('month').toDate();

  const [
    totalStudents,
    totalActiveStudents,
    paymentsThisMonthAgg,
    paymentsAllTimeAgg,
    overdueAgg,
    todayAttendance,
    monthAttendance,
    batchGroups,
    recentActivities,
  ] = await Promise.all([
    prisma.student.count({ where: { isDeleted: false } }),
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
    prisma.payment.aggregate({
      where: { isDeleted: false, dueDate: { lt: now.toDate() }, paidAt: null },
      _count: true,
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
  ]);

  const fullyPaidStudents = await prisma.studentCourse.count({
    where: { isDeleted: false, isCompleted: true },
  });

  const pendingPaymentStudents = await prisma.student.findMany({
    where: {
      isDeleted: false,
      studentCourses: { some: { isDeleted: false, isCompleted: false } },
    },
    include: {
      studentCourses: {
        where: { isDeleted: false, isCompleted: false },
        include: { course: true, payments: { where: { isDeleted: false } } },
      },
    },
  });

  const dueStudents = pendingPaymentStudents
    .map((s) => {
      const totalDue = s.studentCourses.reduce((sum, sc) => {
        const paid = sc.payments.reduce((p, pay) => p + Number(pay.amount), 0);
        return sum + Math.max(0, Number(sc.course.fee) - paid);
      }, 0);
      return { id: s.id, name: s.userId, totalDue };
    })
    .filter((s) => s.totalDue > 0);

  return {
    cards: {
      totalStudents,
      fullyPaidStudents,
      pendingPaymentStudents: dueStudents.length,
      overdueRecords: overdueAgg._count,
      collectedThisMonth: Number(paymentsThisMonthAgg._sum.amount || 0),
      collectedAllTime: Number(paymentsAllTimeAgg._sum.amount || 0),
      todayAttendance,
      monthAttendance,
    },
    recentActivities,
    batchGroups: batchGroups.map((b) => ({
      hscBatch: b.hscBatch,
      batchDay: b.batchDay,
      batchTime: b.batchTime,
      studentCount: b._count.studentId,
    })),
    _meta: { startOfLastMonth },
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
      return {
        id: sc.id,
        courseName: sc.course.name,
        fee: Number(sc.course.fee),
        paid,
        due: Math.max(0, Number(sc.course.fee) - paid),
        isCompleted: sc.isCompleted,
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