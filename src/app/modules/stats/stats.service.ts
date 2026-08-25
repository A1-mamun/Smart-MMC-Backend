import dayjs from 'dayjs';
import { Prisma } from '@prisma/client';
import prisma from '../../utils/prisma';
import { TAdmissionComparison } from './stats.validation';

const getBatchOrder = () => {
  return ['BATCH_25', 'BATCH_26', 'BATCH_27', 'BATCH_28'] as const;
};

const getAdmissionComparisonFromDB = async (filters: TAdmissionComparison) => {
  const today = dayjs();
  const lastYearStart = today.subtract(1, 'year').startOf('year').toDate();
  const lastYearEnd = today.subtract(1, 'year').endOf('year').toDate();
  const thisYearStart = today.startOf('year').toDate();
  const thisYearEnd = today.endOf('year').toDate();

  const orders = getBatchOrder();
  const currentBatch = filters.currentBatch || orders[2];
  const previousBatch = filters.previousBatch || orders[1];

  const [currentCount, previousCount] = await Promise.all([
    prisma.student.count({
      where: {
        isDeleted: false,
        batches: {
          some: {
            hscBatch: currentBatch,
            isDeleted: false,
          },
        },
        admittedAt: { gte: thisYearStart, lte: thisYearEnd },
      },
    }),
    prisma.student.count({
      where: {
        isDeleted: false,
        batches: {
          some: {
            hscBatch: previousBatch,
            isDeleted: false,
          },
        },
        admittedAt: { gte: lastYearStart, lte: lastYearEnd },
      },
    }),
  ]);

  const percentChange = previousCount === 0
    ? (currentCount > 0 ? 100 : 0)
    : Math.round(((currentCount - previousCount) / previousCount) * 100);

  return {
    currentBatch,
    currentBatchCount: currentCount,
    previousBatch,
    previousBatchCount: previousCount,
    percentChange,
    window: {
      current: { from: thisYearStart, to: thisYearEnd },
      previous: { from: lastYearStart, to: lastYearEnd },
    },
  };
};

const getBatchWiseCourseStatsFromDB = async () => {
  const enrollments = await prisma.studentCourse.findMany({
    where: { isDeleted: false },
    include: {
      course: true,
      student: {
        include: {
          batches: { where: { isDeleted: false } },
          payments: { where: { isDeleted: false } },
        },
      },
    },
  });

  const map = new Map<string, { hscBatch: string; courseName: string; studentCount: Set<string>; paidCount: number; dueCount: number }>();

  for (const e of enrollments) {
    const batches = e.student.batches;
    if (batches.length === 0) continue;
    const hscBatch = batches[0].hscBatch;
    const key = `${hscBatch}-${e.course.name}`;
    const entry = map.get(key) || {
      hscBatch,
      courseName: e.course.name,
      studentCount: new Set<string>(),
      paidCount: 0,
      dueCount: 0,
    };
    entry.studentCount.add(e.studentId);
    const paid = e.student.payments
      .filter((p) => p.studentCourseId === e.id)
      .reduce((s, p) => s + Number(p.amount), 0);
    if (paid >= Number(e.course.fee)) entry.paidCount += 1;
    else entry.dueCount += 1;
    map.set(key, entry);
  }

  return Array.from(map.values()).map((e) => ({
    hscBatch: e.hscBatch,
    courseName: e.courseName,
    studentCount: e.studentCount.size,
    paidCount: e.paidCount,
    dueCount: e.dueCount,
  }));
};

const getCollectionTrendFromDB = async () => {
  const months: { label: string; collected: number; count: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const start = dayjs().subtract(i, 'month').startOf('month').toDate();
    const end = dayjs().subtract(i, 'month').endOf('month').toDate();
    const agg = await prisma.payment.aggregate({
      where: { isDeleted: false, paidAt: { gte: start, lte: end } },
      _sum: { amount: true },
      _count: true,
    });
    months.push({
      label: dayjs(start).format('MMM'),
      collected: Number(agg._sum.amount || 0),
      count: agg._count,
    });
  }
  return months;
};

const getPaymentMethodBreakdownFromDB = async () => {
  const groups = await prisma.payment.groupBy({
    by: ['method'],
    where: { isDeleted: false, paidAt: { not: null } },
    _sum: { amount: true },
    _count: true,
  });
  return groups.map((g) => ({
    method: g.method,
    total: Number(g._sum.amount || 0),
    count: g._count,
  }));
};

export const StatsService = {
  getAdmissionComparisonFromDB,
  getBatchWiseCourseStatsFromDB,
  getCollectionTrendFromDB,
  getPaymentMethodBreakdownFromDB,
};

// Suppress unused Prisma import lint warning
type _Unused = Prisma.InputJsonValue;