import httpStatus from 'http-status';
import dayjs from 'dayjs';
import { Prisma } from '@prisma/client';
import { JwtPayload } from 'jsonwebtoken';
import prisma from '../../utils/prisma';
import AppError from '../../errors/AppError';
import { TCheckIn, TManualCheckIn, TGetStudentAttendance, TGetToday } from './attendance.validation';
import calculatePagination from '../../utils/calculatePagination';
import { clearAttendanceCache } from '../../utils/clearCache';
import {
  resolveAttendanceDate,
  TClassDayBatchDay,
  TClassDayStudentBatch,
  TSwapResolution,
  weekdayNameFor,
} from '../../utils/classDayCalendar';

const studentDisplayInclude = {
  student: {
    include: {
      user: { select: { id: true, studentId: true, name: true, nickname: true } },
      studentCourses: {
        where: { isDeleted: false },
        include: { course: true, payments: { where: { isDeleted: false } } },
      },
    },
  },
};

const getTodayDate = () => dayjs().startOf('day').toDate();

/**
 * Resolve the date the attendance row should be stamped with by
 * iterating the student's enrolled courses in order and picking the
 * first course whose swap-resolver yields a `normal` or `swap` outcome.
 *
 * Returns the resolution PLUS the course id that won, so the activity
 * log can record which course was used. When every course rejects, we
 * return the "strongest" rejection — preferring a `swap`/`normal`
 * missing-course message over `no_peer_batch`, which would otherwise
 * mask a legitimate "no class today" / "can't make up 2 days" failure.
 */
const resolveAgainstCourses = async (params: {
  scanDate: Date;
  studentBatches: TClassDayStudentBatch[];
  // The student's currently-enrolled course ids. Order matters — we
  // pick the first one whose resolver returns a real result.
  courseIds: string[];
}): Promise<TSwapResolution & { winningCourseId?: string }> => {
  const { scanDate, studentBatches, courseIds } = params;
  if (courseIds.length === 0 || studentBatches.length === 0) {
    return { kind: 'no_peer_batch' };
  }
  // Fetch every course's BatchDay rows in one round-trip so we don't
  // hit the DB N times for an N-course student. BatchDay rows are
  // hard-deleted (no soft-delete column) so we just filter by course.
  const courseBatchDays = await prisma.batchDay.findMany({
    where: { courseId: { in: courseIds } },
    select: { id: true, courseId: true, days: true },
  });
  // Bucket student batches by courseId so we can pair them with the
  // matching course's BatchDay union. Students may have multiple
  // StudentBatch rows in the same course (rare — different times).
  // `batchDayId` is the join to the course's BatchDay rows.
  const batchDayIdToCourse = new Map<string, string>();
  for (const bd of courseBatchDays) batchDayIdToCourse.set(bd.id, bd.courseId);
  const studentBatchesByCourse = new Map<string, TClassDayStudentBatch[]>();
  for (const sb of studentBatches) {
    if (!sb.batchDayId) continue;
    const courseId = batchDayIdToCourse.get(sb.batchDayId);
    if (!courseId) continue;
    const list = studentBatchesByCourse.get(courseId) || [];
    list.push(sb);
    studentBatchesByCourse.set(courseId, list);
  }
  // Bucket the course's BatchDay rows.
  const courseBatchDaysByCourse = new Map<string, TClassDayBatchDay[]>();
  for (const bd of courseBatchDays) {
    const list = courseBatchDaysByCourse.get(bd.courseId) || [];
    list.push({ id: bd.id, days: bd.days });
    courseBatchDaysByCourse.set(bd.courseId, list);
  }

  // Try each course in the order they were given. First one that
  // returns normal/swap wins. Rejections are remembered in case every
  // course rejects — we surface the most informative one.
  let bestRejection: TSwapResolution = { kind: 'no_peer_batch' };
  // `normal`/`swap` short-circuit above so we never index them, but TS
  // insists the Record cover every union member. Assign them -1 so
  // they never win over a real rejection.
  const rejectionPriority: Record<TSwapResolution['kind'], number> = {
    normal: -1,
    swap: -1,
    no_class_today: 4,
    not_eligible: 3,
    no_peer_batch: 2,
  };
  for (const courseId of courseIds) {
    const sb = studentBatchesByCourse.get(courseId) || [];
    const bd = courseBatchDaysByCourse.get(courseId) || [];
    if (sb.length === 0 || bd.length === 0) continue;
    const result = resolveAttendanceDate({
      scanDate,
      studentBatches: sb,
      courseBatchDays: bd,
    });
    if (result.kind === 'normal' || result.kind === 'swap') {
      return { ...result, winningCourseId: courseId };
    }
    if (rejectionPriority[result.kind] > rejectionPriority[bestRejection.kind]) {
      bestRejection = result;
    }
  }
  return bestRejection;
};

const checkInStudentToDB = async (payload: TCheckIn) => {
  const user = await prisma.user.findUnique({
    where: { studentId: payload.studentId },
    include: {
      student: {
        include: {
          studentCourses: {
            where: { isDeleted: false },
            include: { course: true, payments: { where: { isDeleted: false } } },
          },
          // `batches` powers the swap resolver. We need every active
          // row for this student across all their courses so the
          // helper can build the union of class days. Soft-deleted
          // rows are filtered out so legacy data doesn't pollute the
          // union.
          batches: {
            where: { isDeleted: false },
            include: { batchDayRel: true },
          },
        },
      },
    },
  });

  if (!user || user.isDeleted || !user.student) {
    throw new AppError(httpStatus.NOT_FOUND, 'Student not found');
  }
  if (user.status === 'BANNED') {
    throw new AppError(httpStatus.FORBIDDEN, 'This student is banned');
  }

  const student = user.student;
  const today = getTodayDate();

  // Resolve the actual date the Attendance row should be stamped with
  // (may equal today for a normal check-in, or a different day for a
  // peer-batch make-up). Throws 400 with a user-facing message when
  // the swap is not allowed.
  const resolution = await resolveAgainstCourses({
    scanDate: today,
    studentBatches: student.batches as unknown as TClassDayStudentBatch[],
    courseIds: student.studentCourses.map((sc) => sc.courseId),
  });
  if (resolution.kind === 'no_class_today') {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'No class scheduled in your course today',
    );
  }
  if (resolution.kind === 'not_eligible') {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Cannot make up a class from 2+ days ago. Check your batch schedule.',
    );
  }
  if (resolution.kind === 'no_peer_batch') {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Your batch has no peer batch for make-up. Please attend your scheduled class day.',
    );
  }

  const recordedDate = resolution.date;
  const swapFromDate = resolution.kind === 'swap' ? resolution.swapFromDate : null;

  let attendance = await prisma.attendance.findUnique({
    where: {
      studentId_date: { studentId: student.id, date: recordedDate },
    },
  });

  let isFirstCheckIn = false;
  if (!attendance) {
    attendance = await prisma.attendance.create({
      data: {
        studentId: student.id,
        date: recordedDate,
        method: 'NFC',
        deviceId: payload.deviceId,
        // Nullable column — only set when the resolver returned a
        // swap. The unique constraint on (studentId, date) means a
        // student still gets exactly one row per dedicated class day.
        swapFromDate,
      },
    });
    isFirstCheckIn = true;

    // Audit trail for the swap. Device-triggered checks have no admin
    // actor, so we pass nulls — both fields are nullable in the schema
    // and the activity-log UI already renders null actors as "System".
    if (swapFromDate) {
      await prisma.activityLog.create({
        data: {
          actorId: null,
          actorRole: null,
          action: 'ATTENDANCE_SWAPPED',
          entityType: 'Attendance',
          entityId: attendance.id,
          description: `Make-up attendance: scanned ${weekdayNameFor(today)} → recorded for ${weekdayNameFor(recordedDate)}`,
          metadata: {
            scanDate: today,
            recordedDate,
            courseId: resolution.winningCourseId ?? null,
            deviceId: payload.deviceId ?? null,
          },
        },
      });
    }
  }

  const dueAmount = student.studentCourses.reduce((sum, e) => {
    const paid = e.payments.reduce((s, p) => s + Number(p.amount), 0);
    return sum + Math.max(0, Number(e.course.fee) - paid);
  }, 0);

  const courseNames = student.studentCourses.map((e) => e.course.name);

  await clearAttendanceCache();

  return {
    student: {
      studentId: user.studentId,
      name: user.name,
      nickname: user.nickname,
    },
    attendanceId: attendance.id,
    date: attendance.date,
    swapFromDate: attendance.swapFromDate ?? null,
    checkInAt: attendance.checkInAt,
    method: attendance.method,
    isFirstCheckIn,
    courseNames,
    dueAmount,
    message: isFirstCheckIn
      ? attendance.swapFromDate
        ? `Make-up recorded for ${dayjs(recordedDate).format('ddd, MMM D')} (scanned ${weekdayNameFor(today)})`
        : `Welcome, ${user.name}!`
      : `${user.name} already checked in.`,
  };
};

const manualCheckInToDB = async (
  payload: TManualCheckIn,
  user: JwtPayload,
) => {
  const student = await prisma.student.findUnique({
    where: { id: payload.studentId },
    include: {
      user: true,
      studentCourses: {
        where: { isDeleted: false },
        include: { course: true, payments: { where: { isDeleted: false } } },
      },
      batches: {
        where: { isDeleted: false },
        include: { batchDayRel: true },
      },
    },
  });

  if (!student) throw new AppError(httpStatus.NOT_FOUND, 'Student not found');

  // Resolve the recorded date. Manual check-ins fall into two cases:
  //   1. Admin passes an explicit `payload.date` → record for that
  //      date verbatim. The admin is asserting a specific day, so we
  //      bypass the swap resolver entirely (lets them back-date
  //      historical attendance).
  //   2. Admin omits `payload.date` → behave like a barcode scan for
  //      "today". Apply the same swap resolver so a manual entry
  //      from the admin panel honours the make-up rule too.
  const scanDate = getTodayDate();
  let targetDate = payload.date
    ? dayjs(payload.date).startOf('day').toDate()
    : scanDate;
  let swapFromDate: Date | null = null;

  if (!payload.date) {
    const resolution = await resolveAgainstCourses({
      scanDate,
      studentBatches: student.batches as unknown as TClassDayStudentBatch[],
      courseIds: student.studentCourses.map((sc) => sc.courseId),
    });
    if (resolution.kind === 'no_class_today') {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'No class scheduled in their course today',
      );
    }
    if (resolution.kind === 'not_eligible') {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'Cannot make up a class from 2+ days ago. Check their batch schedule.',
      );
    }
    if (resolution.kind === 'no_peer_batch') {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'Their batch has no peer batch for make-up. Mark attendance for the scheduled class day directly.',
      );
    }
    if (resolution.kind === 'swap') {
      targetDate = resolution.date;
      swapFromDate = resolution.swapFromDate;
    }
  }

  let attendance = await prisma.attendance.findUnique({
    where: { studentId_date: { studentId: student.id, date: targetDate } },
  });

  let isFirstCheckIn = false;
  if (!attendance) {
    attendance = await prisma.attendance.create({
      data: {
        studentId: student.id,
        date: targetDate,
        method: 'MANUAL',
        recordedBy: user.userId,
        swapFromDate,
      },
    });
    isFirstCheckIn = true;

    await prisma.activityLog.create({
      data: {
        actorId: user.userId,
        actorRole: user.role as 'SUPER_ADMIN' | 'ADMIN',
        action: swapFromDate ? 'ATTENDANCE_SWAPPED' : 'ATTENDANCE_MARKED',
        entityType: 'Attendance',
        entityId: attendance.id,
        description: swapFromDate
          ? `Manual make-up: scanned ${weekdayNameFor(scanDate)} → recorded for ${weekdayNameFor(targetDate)}`
          : `Manual attendance for "${student.user.name}"`,
        metadata: {
          studentId: student.id,
          date: targetDate,
          scanDate: swapFromDate ? scanDate : undefined,
          courseId: student.studentCourses[0]?.courseId ?? null,
        },
      },
    });
  }

  await clearAttendanceCache();

  return {
    student: {
      studentId: student.user.studentId,
      name: student.user.name,
      nickname: student.user.nickname,
    },
    attendanceId: attendance.id,
    date: attendance.date,
    swapFromDate: attendance.swapFromDate ?? null,
    checkInAt: attendance.checkInAt,
    method: attendance.method,
    isFirstCheckIn,
    courseNames: student.studentCourses.map((e) => e.course.name),
    message: isFirstCheckIn
      ? attendance.swapFromDate
        ? `Make-up recorded for ${dayjs(targetDate).format('ddd, MMM D')} (scanned ${weekdayNameFor(scanDate)}).`
        : `Attendance marked for ${student.user.name}.`
      : `${student.user.name} was already marked on ${dayjs(targetDate).format('YYYY-MM-DD')}.`,
  };
};

const getTodayAttendanceFromDB = async (filters: TGetToday) => {
  const { page, limit, skip } = calculatePagination(filters);
  const today = getTodayDate();

  const where: Prisma.AttendanceWhereInput = {
    date: today,
    student: { isDeleted: false },
  };

  if (filters.hscBatch) {
    where.student = {
      isDeleted: false,
      batches: { some: { hscBatch: filters.hscBatch as 'BATCH_25' | 'BATCH_26' | 'BATCH_27' | 'BATCH_28', isDeleted: false } },
    };
  }
  if (filters.batchDay || filters.batchTime) {
    const batchWhere: Prisma.StudentBatchWhereInput = { isDeleted: false };
    if (filters.batchDay) batchWhere.batchDay = filters.batchDay as 'SAT' | 'SUN' | 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI';
    if (filters.batchTime) batchWhere.batchTime = filters.batchTime as 'TIME_7AM' | 'TIME_4PM';
    where.student = { ...(where.student as object), batches: { some: batchWhere } };
  }

  const [data, total] = await Promise.all([
    prisma.attendance.findMany({
      where,
      skip,
      take: limit,
      orderBy: { checkInAt: 'desc' },
      include: studentDisplayInclude,
    }),
    prisma.attendance.count({ where }),
  ]);

  return { data, meta: { page, limit, total } };
};

const getStudentAttendanceFromDB = async (params: TGetStudentAttendance) => {
  const { studentId } = params.params;
  const { page, limit, skip, sortBy, sortOrder } = calculatePagination(params.query);
  const where: Prisma.AttendanceWhereInput = { studentId };
  if (params.query.startDate || params.query.endDate) {
    where.date = {
      ...(params.query.startDate ? { gte: params.query.startDate } : {}),
      ...(params.query.endDate ? { lte: params.query.endDate } : {}),
    };
  }

  const [data, total] = await Promise.all([
    prisma.attendance.findMany({
      where,
      skip,
      take: limit,
      orderBy: { [sortBy]: sortOrder },
    }),
    prisma.attendance.count({ where }),
  ]);

  const presentCount = data.length;

  return {
    data,
    meta: { page, limit, total },
    summary: { totalPresent: presentCount },
  };
};

const getAttendanceStatsFromDB = async () => {
  const startOfMonth = dayjs().startOf('month').toDate();
  const endOfMonth = dayjs().endOf('month').toDate();

  const [monthlyPresent, totalStudents, todayPresent] = await Promise.all([
    prisma.attendance.count({
      where: { date: { gte: startOfMonth, lte: endOfMonth } },
    }),
    prisma.student.count({ where: { isDeleted: false } }),
    prisma.attendance.count({ where: { date: getTodayDate() } }),
  ]);

  return {
    monthlyPresent,
    totalActiveStudents: totalStudents,
    todayPresent,
  };
};

const deleteAttendanceFromDB = async (id: string, user: JwtPayload) => {
  const existing = await prisma.attendance.findUnique({ where: { id } });
  if (!existing) throw new AppError(httpStatus.NOT_FOUND, 'Attendance record not found');

  await prisma.attendance.delete({ where: { id } });
  await prisma.activityLog.create({
    data: {
      actorId: user.userId,
      actorRole: user.role as 'SUPER_ADMIN' | 'ADMIN',
      action: 'ATTENDANCE_DELETED',
      entityType: 'Attendance',
      entityId: id,
      description: 'Attendance record deleted',
    },
  });
  await clearAttendanceCache();
  return null;
};

export const AttendanceService = {
  checkInStudentToDB,
  manualCheckInToDB,
  getTodayAttendanceFromDB,
  getStudentAttendanceFromDB,
  getAttendanceStatsFromDB,
  deleteAttendanceFromDB,
};