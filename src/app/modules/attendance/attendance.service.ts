import httpStatus from 'http-status';
import dayjs from 'dayjs';
import { Prisma } from '@prisma/client';
import { JwtPayload } from 'jsonwebtoken';
import prisma from '../../utils/prisma';
import AppError from '../../errors/AppError';
import {
  TCheckIn,
  TManualCheckIn,
  TGetStudentAttendance,
  TGetToday,
} from './attendance.validation';
import calculatePagination from '../../utils/calculatePagination';
import { clearAttendanceCache } from '../../utils/clearCache';
import {
  resolveAttendanceDate,
  TClassDayBatchDay,
  TClassDayStudentBatch,
  TSwapResolution,
  parseTimeOfDay,
  weekdayNameFor,
} from '../../utils/classDayCalendar';

const studentDisplayInclude = {
  student: {
    include: {
      user: { select: { id: true, mobile: true, name: true, nickname: true } },
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
  // The scanner can emit EITHER:
  //   - a mobile number (legacy / manual entry path), or
  //   - a `StudentCourse.studentCourseId` (the printed handle on the
  //     student ID card, e.g. "272200" for HSC 27 year 2 roll 200).
  // We resolve in two steps so both work:
  //   1. Try `User.mobile` first (cheap, unique-indexed).
  //   2. On miss, fall back to a `StudentCourse.studentCourseId`
  //      lookup. The `studentCourseId` is `@unique` and indexed, so
  //      this is a single round-trip.
  // The old `User.studentId` (the global per-user string) was
  // dropped along with the rest of the User refactor — the
  // per-enrollment `studentCourseId` is the surviving printable
  // handle, scoped per enrollment.
  // console.log(`Check-in attempt: ${payload.studentId} (device ${payload.deviceId})`);
  const input = payload.studentId.trim();

  // Step 1: try by mobile.
  let user = await prisma.user.findUnique({
    where: { mobile: input },
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

  // Step 2: fall back to the printed handle on the ID card.
  if (!user) {
    const enrollment = await prisma.studentCourse.findFirst({
      where: { studentCourseId: input, isDeleted: false },
      select: { studentId: true },
    });
    if (enrollment) {
      user = await prisma.user.findUnique({
        where: {
          id: (
            await prisma.student.findUnique({
              where: { id: enrollment.studentId },
              select: { userId: true },
            })
          )?.userId,
        },
        include: {
          student: {
            include: {
              studentCourses: {
                where: { isDeleted: false },
                include: { course: true, payments: { where: { isDeleted: false } } },
              },
              batches: {
                where: { isDeleted: false },
                include: { batchDayRel: true },
              },
            },
          },
        },
      });
    }
  }

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
    throw new AppError(httpStatus.BAD_REQUEST, 'No class scheduled in your course today');
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

  /*
   * Time-window guard for the automatic-attendance kiosk.
   *
   * Rule: check-ins are only allowed starting at the class start
   * time and up to 5 minutes after. Scans outside this window
   * (early arrivals, late stragglers) are rejected so the kiosk
   * doesn't accept attendance for a class that hasn't started yet
   * or that ended more than 5 minutes ago.
   *
   * The rule applies symmetrically to `normal` (the scan day IS
   * the class day) and `swap` (the scan day is a peer batch and
   * the row is recorded for the dedicated day). In both cases
   * `startsAtMinutes` is the wall-clock start of the resolved
   * class — the only thing that matters is "is `now_minutes`
   * within `[start, start + 5]`?".
   *
   * Admin-driven manual check-ins bypass this gate (the manual
   * endpoint doesn't call into this helper — see
   * `manualCheckInToDB`). The kiosk is the only caller that
   * benefits from the strict window, and gating it server-side
   * means even a hand-typed scan in the kiosk UI can't bypass it.
   */
  /*
   * Resolve the matched BatchDay + slot index ONCE so both the
   * admit guard (slotStates[i] === false) and the window guard
   * (manualWindowOverride[i] === true) below can read the
   * same row. Hoisted to the top of this block because both
   * guards need it.
   */
  const matchedSlot = await (async (): Promise<{
    manualOpen: boolean;
    slotOn: boolean;
  }> => {
    if (!resolution.winningCourseId) return { manualOpen: false, slotOn: false };
    const winningBatch = student.batches.find(
      (b) => b.batchDayRel?.courseId === resolution.winningCourseId,
    );
    if (!winningBatch?.batchDayId) return { manualOpen: false, slotOn: false };
    const winningBatchDay = await prisma.batchDay.findUnique({
      where: { id: winningBatch.batchDayId },
      select: { slotStates: true, manualWindowOverride: true, times: true },
    });
    if (!winningBatchDay) return { manualOpen: false, slotOn: false };
    const idx = winningBatchDay.times.indexOf(winningBatch.batchTime);
    return {
      manualOpen: idx >= 0 ? winningBatchDay.manualWindowOverride?.[idx] === true : false,
      slotOn: idx >= 0 ? winningBatchDay.slotStates?.[idx] === true : false,
    };
  })();

  /*
   * Per-slot admit flag (slotStates[i] === false → kiosk locked
   * out). Manual admin check-in via `/attendance/manual` bypasses
   * this gate — see `manualCheckInToDB` — so the admin can still
   * backfill a record after the fact. Runs BEFORE the time
   * window so the kiosk also gets disabled if the admin turns
   * attendance OFF mid-class.
   */
  if (matchedSlot.slotOn === false) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Taking attendance is currently disabled for this slot. Ask the admin to turn on attendance for this batch's time slot.",
    );
  }

  const CHECK_IN_WINDOW_MIN = 5;
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const earliest = resolution.startsAtMinutes;
  const latest = resolution.startsAtMinutes + CHECK_IN_WINDOW_MIN;
  /*
   * Check-in window override: if the admin flipped
   * `manualWindowOverride[slotIdx] = true` (e.g. opened the
   * window early for an early arrival, or kept it open past
   * the 5-minute mark because the class was delayed), skip
   * the 5-min guard entirely. The admin's override is the
   * explicit "open the window" signal — they close it by
   * flipping the switch back to false. The override is
   * gated on the slot being ON (already enforced above), so
   * a disabled slot stays locked out regardless of any
   * stale override.
   */
  if (!matchedSlot.manualOpen) {
    if (nowMin < earliest) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `The check-in window hasn't opened yet. It opens at ${minutesToClock(earliest)}.`,
      );
    }
    if (nowMin > latest) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `The check-in window has closed. It closed at ${minutesToClock(latest)}.`,
      );
    }
  }
  // We don't need slotOverrideOpen / overrideOn because
  // winningBatchDay is in scope. Use it directly.

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
      // Mobile replaces the dropped `User.studentId` as the per-account
      // identifier. For per-enrollment display, callers can join on
      // student.studentCourses[].studentCourseId instead.
      mobile: user.mobile,
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

const manualCheckInToDB = async (payload: TManualCheckIn, user: JwtPayload) => {
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
  let targetDate = payload.date ? dayjs(payload.date).startOf('day').toDate() : scanDate;
  let swapFromDate: Date | null = null;

  if (!payload.date) {
    const resolution = await resolveAgainstCourses({
      scanDate,
      studentBatches: student.batches as unknown as TClassDayStudentBatch[],
      courseIds: student.studentCourses.map((sc) => sc.courseId),
    });
    if (resolution.kind === 'no_class_today') {
      throw new AppError(httpStatus.BAD_REQUEST, 'No class scheduled in their course today');
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
      // Mobile replaces the dropped `User.studentId` as the per-account
      // identifier on the User object. The receipt / display layer
      // joins on StudentCourse.studentCourseId when it needs the
      // per-enrollment handle.
      mobile: student.user.mobile,
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
      batches: {
        some: {
          hscBatch: filters.hscBatch as 'BATCH_25' | 'BATCH_26' | 'BATCH_27' | 'BATCH_28',
          isDeleted: false,
        },
      },
    };
  }
  if (filters.batchDay || filters.batchTime) {
    const batchWhere: Prisma.StudentBatchWhereInput = { isDeleted: false };
    if (filters.batchDay)
      batchWhere.batchDay = filters.batchDay as
        'SAT' | 'SUN' | 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI';
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

/**
 * Render a minutes-since-midnight integer as "h:mm AM/PM" so we can
 * echo the kiosk's check-in-window boundaries back to the operator
 * ("opens at 4:00 PM", "closed at 4:05 PM"). Mirrors `parseTimeOfDay`
 * (now centralised in `classDayCalendar.ts`) but in the opposite
 * direction — kept local because it's only needed by the kiosk
 * error messages above.
 */
const minutesToClock = (minutes: number): string => {
  const hour24 = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const meridiem = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${meridiem}`;
};

/**
 * Shape of `GET /attendance/current-batch` — the kiosk view polls
 * this endpoint every minute and on every successful scan to
 * decide what to display.
 *
 * `kind`:
 *   - `current` — a batch is happening right now (now's time falls
 *     inside a 60-min window starting at the batch's start time).
 *   - `upcoming` — no batch is happening right now, but one is
 *     scheduled later today. `minutesUntilStart` is the lead time.
 *   - `none` — no batch is scheduled at all today (e.g. public
 *     holiday, all courses paused). The kiosk shows a calm
 *     "no class right now" message.
 */
export type TCurrentBatch =
  | {
      kind: 'current';
      courseId: string;
      courseName: string;
      batchDayId: string;
      batchDayName: string;
      time: string;
      startsAtMinutes: number;
      endsAtMinutes: number;
      // Per-batch class duration in total minutes. Drives the
      // kiosk's live "X min remaining" / progress bar so the
      // operator knows how much time is left in the current class
      // (and so the auto-rotation poll flips to the next batch
      // exactly when this one ends).
      durationMinutes: number;
      // Whether this slot is currently accepting attendance. Set to
      // `true` for the resolved slot — the backend rejects scans
      // server-side when the matched slot is `slotEnabled = false`,
      // so this field is mostly informational on the frontend. The
      // kiosk uses it to render the "Admit: Closed / Open" pill.
      slotEnabled: boolean;
      // Whether the admin's manual check-in window override is
      // currently open. When true, the kiosk accepts scans for
      // this slot regardless of the wall clock (the admin opened
      // the window early or kept it open past the 5-min mark).
      // The frontend can use this to show a "Window override
      // active" hint so the operator knows the standard time
      // window isn't in effect.
      manualWindowOpen: boolean;
    }
  | {
      kind: 'upcoming';
      courseId: string;
      courseName: string;
      batchDayId: string;
      batchDayName: string;
      time: string;
      minutesUntilStart: number;
    }
  | { kind: 'none' };

/**
 * Compute which batch (course + day + time) is happening RIGHT NOW
 * for the kiosk / automatic-attendance view. We pull every active
 * `BatchDay` whose `days[]` includes today's weekday, then for each
 * `time` slot we compare the current wall-clock minute against the
 * parsed slot. The "current" rule is a 60-min window starting at
 * the slot start (matches a 1-hour class). If nothing is current we
 * return the next upcoming slot (sorted by start time) so the kiosk
 * can pre-announce. If nothing is scheduled today at all we return
 * `{ kind: 'none' }`.
 *
 * Performance: a single round-trip pulls every BatchDay for active
 * courses. For an institute with ~10 active courses and ~20 slots
 * total this is < 1ms of server work, so caching is unnecessary.
 */
const getCurrentBatchFromDB = async (): Promise<TCurrentBatch> => {
  const now = new Date();
  const todayMinutes = now.getHours() * 60 + now.getMinutes();
  const todayName = weekdayNameFor(now);

  // Pull every BatchDay for active, non-deleted courses whose days[]
  // include today. We over-fetch slightly (one query for current +
  // upcoming) so a single endpoint can serve both states.
  // `durationMinutes` is fetched too so the kiosk can render a
  // real-time progress bar / "X mins remaining" countdown (and so
  // the auto-rotation poll can flip to the next batch exactly when
  // this one ends, regardless of whether the admin set a
  // 60-min default or a custom 75-min class).
  const allDays = await prisma.batchDay.findMany({
    where: {
      course: { isActive: true, isDeleted: false },
    },
    select: {
      id: true,
      name: true,
      days: true,
      times: true,
      durationMinutes: true,
      // Per-slot admit-enabled flag (parallel to `times[]`).
      // The kiosk only accepts scans for slots whose flag is
      // true. The override is a separate per-slot flag the
      // admin toggles to open the check-in window early or
      // keep it open past the 5-min mark — when it's true the
      // kiosk admits scans for the slot regardless of the wall
      // clock; when false (or absent) the default 5-min window
      // applies. See `checkInStudentToDB` for the equivalent
      // server-side backstop.
      slotStates: true,
      manualWindowOverride: true,
      course: { select: { id: true, name: true } },
    },
  });

  // Flatten into per-slot rows and parse times once. The slot
  // resolution is in-memory so we don't have to round-trip the
  // DB for each candidate. `durationMinutes` is per-BatchDay (not
  // per-slot) — a single batch has one duration, applied to every
  // `times[]` slot it owns. Defaults to 60 minutes when the admin
  // hasn't set an explicit value (legacy compatibility).
  type Slot = {
    courseId: string;
    courseName: string;
    batchDayId: string;
    batchDayName: string;
    time: string;
    minutes: number;
    durationMinutes: number;
    // Per-slot "barcode scan allowed right now" flag. The
    // admin toggles this manually — the kiosk treats `true`
    // as "admit scans" and `false` as "reject scans". The
    // cross-course "only one ON" invariant is enforced at
    // write time by `toggleBatchSlotToDB`, so at any given
    // time AT MOST ONE slot in the database is true.
    slotEnabled: boolean;
    // Per-slot "check-in window override". When the i-th
    // element is `true`, the kiosk accepts scans for that
    // slot regardless of the wall clock (admin opened the
    // window early for an early arrival, or kept it open
    // past the 5-min mark). When `false` (or absent), the
    // kiosk uses the default 5-minute window centred on
    // the slot start time.
    manualWindowOpen: boolean;
  };
  const slots: Slot[] = [];
  for (const bd of allDays) {
    if (!bd.days.some((d) => d.toLowerCase() === todayName.toLowerCase())) {
      continue;
    }
    const duration = bd.durationMinutes ?? 60;
    bd.times.forEach((t, i) => {
      const minutes = parseTimeOfDay(t);
      if (minutes === null) return;
      // Read the raw booleans from BatchDay. Default to false
      // so a missing / out-of-range index never accidentally
      // lets scans through. The kiosk combines these with the
      // wall-clock auto-cycle further down to decide whether
      // the slot is "current" (admitting right now).
      const slotEnabled = bd.slotStates?.[i] ?? false;
      const manualWindowOpen = bd.manualWindowOverride?.[i] === true;
      slots.push({
        courseId: bd.course.id,
        courseName: String(bd.course.name),
        batchDayId: bd.id,
        batchDayName: bd.name ?? '',
        time: t,
        minutes,
        durationMinutes: duration,
        slotEnabled,
        manualWindowOpen,
      });
    });
  }
  if (slots.length === 0) return { kind: 'none' };

  // The "current" window is [start, start + duration) — a 1h 15m
  // class runs from 0 to 75, a 2h lab runs from 0 to 120. The
  // kiosk auto-flips to the next batch the moment `now` crosses
  // `endsAtMinutes`, so admins don't have to wait for the 60s poll
  // when the next batch is starting in the same minute.
  //
  // We require `slotEnabled` here so the admin's manual toggle
  // disables the slot from the kiosk's perspective. A slot that's
  // current by the clock but disabled by the admin returns
  // `{ kind: 'none' }` so the kiosk shows the calm "no class" message
  // rather than promoting a disabled slot. The manual window
  // override short-circuits the time check: when `manualWindowOpen`
  // is true, the slot is "current" regardless of the wall clock.
  // This lets the admin open the window early (e.g. admit an
  // early arrival) or keep it open past the 5-min mark (e.g.
  // when the class is delayed). The override is gated on the
  // slot being ON (already enforced above), so a disabled slot
  // stays locked out regardless of any stale override.
  const currentSlot = slots.find(
    (s) =>
      s.slotEnabled &&
      (s.manualWindowOpen ||
        (todayMinutes >= s.minutes && todayMinutes < s.minutes + s.durationMinutes)),
  );
  if (currentSlot) {
    return {
      kind: 'current',
      courseId: currentSlot.courseId,
      courseName: currentSlot.courseName,
      batchDayId: currentSlot.batchDayId,
      batchDayName: currentSlot.batchDayName,
      time: currentSlot.time,
      startsAtMinutes: currentSlot.minutes,
      endsAtMinutes: currentSlot.minutes + currentSlot.durationMinutes,
      durationMinutes: currentSlot.durationMinutes,
      slotEnabled: true,
      manualWindowOpen: currentSlot.manualWindowOpen,
    };
  }

  // No current slot — find the next upcoming one (any slot whose
  // start is in the future). We pick the earliest so the kiosk
  // can pre-announce the next class. The slotEnabled flag is
  // NOT filtered here — the kiosk's pre-announce message can
  // mention the soonest scheduled slot regardless of its
  // current admit state, so the operator sees what's coming
  // up next.
  const upcomingSlots = slots
    .filter((s) => s.minutes > todayMinutes)
    .sort((a, b) => a.minutes - b.minutes);
  if (upcomingSlots.length === 0) return { kind: 'none' };
  const next = upcomingSlots[0];
  return {
    kind: 'upcoming',
    courseId: next.courseId,
    courseName: next.courseName,
    batchDayId: next.batchDayId,
    batchDayName: next.batchDayName,
    time: next.time,
    minutesUntilStart: next.minutes - todayMinutes,
  };
};

export const AttendanceService = {
  checkInStudentToDB,
  manualCheckInToDB,
  getTodayAttendanceFromDB,
  getStudentAttendanceFromDB,
  getAttendanceStatsFromDB,
  deleteAttendanceFromDB,
  getCurrentBatchFromDB,
};
