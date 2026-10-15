import dayjs from 'dayjs';
import prisma from '../../utils/prisma';
import { TAdmissionComparison } from './stats.validation';
// Importing for the .tz pulse — utc + timezone plugins get extended
// transitively via classDayCalendar.ts which is already pulled in
// elsewhere. Re-importing here makes the dependency explicit.
import '../../utils/classDayCalendar';
import { TUserRole } from '../../interface/userRole';

const getBatchOrder = () => {
  return ['BATCH_25', 'BATCH_26', 'BATCH_27', 'BATCH_28'] as const;
};

const getAdmissionComparisonFromDB = async (filters: TAdmissionComparison) => {
  // Anchor year boundaries to Asia/Dhaka so the "this year" cohort
  // lines up with the institute's calendar, not the server's.
  const today = dayjs().tz('Asia/Dhaka');
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

  const percentChange =
    previousCount === 0
      ? currentCount > 0
        ? 100
        : 0
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

  const map = new Map<
    string,
    {
      hscBatch: string;
      courseName: string;
      studentCount: Set<string>;
      paidCount: number;
      dueCount: number;
    }
  >();

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
    // Per-month bucket anchored to Asia/Dhaka wall-clock so a payment
    // made on the last day of a BD month doesn't spill into the next
    // bucket when the server is in UTC (or any other non-BD TZ).
    const start = dayjs().tz('Asia/Dhaka').subtract(i, 'month').startOf('month').toDate();
    const end = dayjs().tz('Asia/Dhaka').subtract(i, 'month').endOf('month').toDate();
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

/**
 * Per-ONGOING-course aggregate for the admin dashboard.
 *
 *   - `studentCount` is returned for every caller. Counts distinct
 *     students with a non-deleted enrollment in the course.
 *   - `totalEarned`, `ppFeeTotal`, `netProfit` are returned ONLY
 *     when the caller is SUPER_ADMIN. We gate on the server
 *     because the financials are sensitive (PP commissions are
 *     a payroll line) — the frontend must never have to remember
 *     to hide them. ADMIN callers receive the same shape with
 *     those three fields set to 0.
 *
 *  Computation notes:
 *  - `totalEarned` = sum of Payment.amount for non-deleted
 *    payments attached to a non-deleted enrollment in this course.
 *    (Cross-course payments — paidAt on a StudentCourseId that
 *    belongs to a different course — don't count here. The
 *    `studentCourse.courseId = course.id` join filters those
 *    out at the SQL level.)
 *  - `ppFeeTotal` = sum of Student.ppFee for every student
 *    enrolled in this course whose Student.ppId is not null
 *    (i.e. they were attributed to a referrer at admission).
 *    This is the "outstanding" commission — the centre's gross
 *    PP liability, not the amount already paid out via PpPayment.
 *    The admin's PP detail view shows the paid/due split; this
 *    KPI shows the gross owed per course.
 *  - `netProfit` = totalEarned − ppFeeTotal. Simple by design:
 *    it ignores other costs (instructor salary, room rent, etc.)
 *    because those aren't tracked per-course today. When they
 *    are, this formula is the place to extend.
 *
 *  Returns courses ordered by `createdAt DESC` so the most
 *  recently-launched course surfaces first — the admin can then
 *  see at a glance which course is the "newest live" and decide
 *  whether to drill in.
 */
const getOngoingCourseStatsFromDB = async (requesterRole: TUserRole) => {
  const includeFinancials = requesterRole === 'SUPER_ADMIN';

  const courses = await prisma.course.findMany({
    where: { isDeleted: false, status: 'ONGOING' },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      fee: true,
      hscBatch: true,
      // Count distinct students with a non-deleted enrollment.
      // groupBy is the cheapest way to get a true DISTINCT count
      // because the underlying `student_courses` table can have
      // soft-deleted + re-admitted rows for the same student.
      studentCourses: {
        where: { isDeleted: false, student: { isDeleted: false } },
        select: {
          studentId: true,
          // Only fetch payment totals when the caller is super admin.
          // For admin callers we skip the include to keep the query
          // cheap — they won't see the financial block anyway.
          payments: includeFinancials
            ? { where: { isDeleted: false }, select: { amount: true } }
            : false,
          student: {
            select: {
              // PP linkage for the per-course commission total.
              ppId: true,
              ppFee: true,
            },
          },
        },
      },
    },
  });

  return courses.map((c) => {
    // studentCount: distinct studentIds, ignoring soft-deletes (already
    // filtered in the where clause) and double-counted re-enrollments
    // (Set keeps one slot per studentId).
    const distinctStudentIds = new Set<string>();
    for (const sc of c.studentCourses) distinctStudentIds.add(sc.studentId);
    const studentCount = distinctStudentIds.size;

    if (!includeFinancials) {
      return {
        id: c.id,
        name: c.name,
        hscBatch: c.hscBatch,
        fee: Number(c.fee),
        studentCount,
        // Explicit zeros (not undefined) so the frontend can render
        // the same shape for every role without a presence check.
        totalEarned: 0,
        ppFeeTotal: 0,
        netProfit: 0,
      };
    }

    let totalEarned = 0;
    let ppFeeTotal = 0;
    for (const sc of c.studentCourses) {
      for (const p of sc.payments ?? []) {
        totalEarned += Number(p.amount);
      }
      // PP fee is a per-student commission. Only students who were
      // attributed to a referrer (ppId set) contribute. A student
      // with a NULL ppId has no PP liability at all.
      if (sc.student.ppId && sc.student.ppFee != null) {
        ppFeeTotal += Number(sc.student.ppFee);
      }
    }

    return {
      id: c.id,
      name: c.name,
      hscBatch: c.hscBatch,
      fee: Number(c.fee),
      studentCount,
      totalEarned,
      ppFeeTotal,
      netProfit: totalEarned - ppFeeTotal,
    };
  });
};

export const StatsService = {
  getAdmissionComparisonFromDB,
  getBatchWiseCourseStatsFromDB,
  getCollectionTrendFromDB,
  getPaymentMethodBreakdownFromDB,
  getOngoingCourseStatsFromDB,
};
