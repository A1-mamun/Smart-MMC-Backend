import httpStatus from 'http-status';
import dayjs from 'dayjs';
import { Prisma, AttendanceMethod } from '@prisma/client';
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
  resolveTodayAgainstStudentBatches,
  TClassDayStudentBatch,
  parseTimeOfDay,
  weekdayNameForInstitute,
  getInstituteToday,
  instituteLocalDate,
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

/**
 * Fetch the BatchDay row for the slot the student is enrolled in
 * for `today`. Used by the check-in path to read the per-slot admin
 * toggles (slotStates[i], manualWindowOverride[i]) that gate whether
 * the kiosk accepts scans for this slot right now.
 *
 * Returns `null` if no BatchDay row matches — caller falls through
 * to "no slot" semantics.
 */
const fetchBatchDayForStudent = async (studentId: string, weekday: string) => {
  // Find the student's active StudentBatch rows for the day, then
  // pull the BatchDay rows they reference. We only need the rows
  // that include `weekday` in their `days[]`.
  const studentBatches = await prisma.studentBatch.findMany({
    where: { studentId, isDeleted: false },
    select: {
      batchDayId: true,
      batchTime: true,
      batchDayRel: {
        select: {
          id: true,
          courseId: true,
          days: true,
          slotStates: true,
          manualWindowOverride: true,
          times: true,
        },
      },
    },
  });
  // Find a row whose BatchDay.days includes today AND whose batchDayRel
  // exists. A student enrolled in a deleted BatchDay is ignored.
  const matched = studentBatches.find((b) => {
    if (!b.batchDayRel) return false;
    return b.batchDayRel.days.some((d) => d.toLowerCase() === weekday.toLowerCase());
  });
  return matched?.batchDayRel ?? null;
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
  const input = payload.studentId.trim();

  // Step 1: try by mobile.
  // let user = await prisma.user.findUnique({
  //   where: { mobile: input },
  //   include: {
  //     student: {
  //       include: {
  //         studentCourses: {
  //           where: { isDeleted: false },
  //           include: { course: true, payments: { where: { isDeleted: false } } },
  //         },
  //         // `batches` drives the today-resolver. Soft-deleted rows
  //         // are filtered out so legacy data doesn't pollute the
  //         // dedicated-day set.
  //         batches: {
  //           where: { isDeleted: false },
  //           include: { batchDayRel: true },
  //         },
  //       },
  //     },
  //   },
  // });

  // Step 2: fall back to the printed handle on the ID card.
  // if (!user) {
  const enrollment = await prisma.studentCourse.findFirst({
    where: { studentCourseId: input, isDeleted: false },
    select: { studentId: true },
  });

  if (!enrollment) {
    throw new AppError(httpStatus.NOT_FOUND, 'Student not found');
  }

  const user = await prisma.user.findUnique({
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
  //   }
  // }

  if (!user || user.isDeleted || !user.student) {
    throw new AppError(httpStatus.NOT_FOUND, 'Student not found');
  }
  if (user.status === 'BANNED') {
    throw new AppError(httpStatus.FORBIDDEN, 'This student is banned');
  }

  const student = user.student;
  const today = getInstituteToday();
  const todayWeekday = weekdayNameForInstitute(today);

  // Resolve whether today is a dedicated class day for this
  // student. Make-up attendance is no longer supported — a scan on
  // a day the student isn't enrolled in is rejected with a 400.
  const resolution = resolveTodayAgainstStudentBatches(
    student.batches as unknown as TClassDayStudentBatch[],
  );
  if (resolution.kind === 'no_class_today') {
    throw new AppError(httpStatus.BAD_REQUEST, 'No class scheduled for your batch today');
  }
  if (resolution.kind === 'no_enrollment') {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Student has no active enrollment. Please contact admin.',
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
   * Admin-driven manual check-ins bypass this gate (the manual
   * endpoint doesn't call into this helper — see
   * `manualCheckInToDB`). The kiosk is the only caller that
   * benefits from the strict window, and gating it server-side
   * means even a hand-typed scan in the kiosk UI can't bypass it.
   */
  /*
   * Resolve the matched BatchDay ONCE so both the admit guard
   * (slotStates[i] === false) and the window guard
   * (manualWindowOverride[i] === true) below can read the same
   * row. Hoisted to the top of this block because both guards
   * need it.
   */
  const matchedBatchDay = await fetchBatchDayForStudent(student.id, todayWeekday);
  let slotOn = false;
  let manualOpen = false;
  let matchedSlotIdx = -1;
  if (matchedBatchDay) {
    // Pick the slot index by matching the student's own batchTime
    // against BatchDay.times[]. If the BatchDay has only one slot
    // (legacy), it always matches index 0.
    const studentSlotTime = (student.batches || []).find(
      (b) => b.batchDayRel?.id === matchedBatchDay.id,
    )?.batchTime;
    matchedSlotIdx = studentSlotTime ? matchedBatchDay.times.indexOf(studentSlotTime) : 0;
    if (matchedSlotIdx >= 0) {
      slotOn = matchedBatchDay.slotStates?.[matchedSlotIdx] === true;
      manualOpen = matchedBatchDay.manualWindowOverride?.[matchedSlotIdx] === true;
    }
  }

  /*
   * Per-slot admit flag (slotStates[i] === false → kiosk locked
   * out). Manual admin check-in via `/attendance/manual` bypasses
   * this gate — see `manualCheckInToDB` — so the admin can still
   * backfill a record after the fact. Runs BEFORE the time
   * window so the kiosk also gets disabled if the admin turns
   * attendance OFF mid-class.
   */
  if (slotOn === false) {
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
  if (!manualOpen) {
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

  // Shaped for Prisma @db.Date: UTC-midnight Date whose UTC date
  // parts equal the BD-local YYYY-MM-DD.
  const recordedDate = instituteLocalDate(today);

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
        // `status` is PRESENT for a fresh check-in. The cron writes
        // ABSENT for students who never scanned; this path can't
        // produce ABSENT because we just verified the student scanned
        // during their enrolled slot.
        status: 'PRESENT',
        deviceId: payload.deviceId,
      },
    });

    isFirstCheckIn = true;
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
    checkInAt: attendance.checkInAt,
    method: attendance.method,
    status: attendance.status,
    isFirstCheckIn,
    courseNames,
    dueAmount,
    message: isFirstCheckIn ? `Welcome, ${user.name}!` : `${user.name} already checked in.`,
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

  // Manual check-ins fall into two cases:
  //   1. Admin passes an explicit `payload.date` → record for that
  //      date verbatim. The admin is asserting a specific day, so we
  //      skip the today-resolver entirely (lets them back-fill
  //      historical attendance).
  //   2. Admin omits `payload.date` → behave like a barcode scan for
  //      "today". Apply the today-resolver so a manual entry on a
  //      non-enrolled day is rejected with the same 400 as the kiosk.
  let targetDate: Date;
  if (payload.date) {
    // Anchor to BD-local calendar day using `instituteLocalDate` so
    // the UTC date parts equal the admin's intended YYYY-MM-DD
    // (otherwise we'd be off by ±1 day around the BD midnight boundary).
    targetDate = instituteLocalDate(payload.date);
  } else {
    const resolution = resolveTodayAgainstStudentBatches(
      student.batches as unknown as TClassDayStudentBatch[],
    );
    if (resolution.kind === 'no_class_today') {
      throw new AppError(httpStatus.BAD_REQUEST, 'No class scheduled for their batch today');
    }
    if (resolution.kind === 'no_enrollment') {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'Student has no active enrollment. Please contact admin.',
      );
    }
    targetDate = instituteLocalDate(getInstituteToday());
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
        // Same as the NFC path: a manual entry is always PRESENT.
        // The cron inserts ABSENT for students who never scanned.
        status: 'PRESENT',
        recordedBy: user.userId,
      },
    });
    isFirstCheckIn = true;

    await prisma.activityLog.create({
      data: {
        actorId: user.userId,
        actorRole: user.role as 'SUPER_ADMIN' | 'ADMIN',
        action: 'ATTENDANCE_MARKED',
        entityType: 'Attendance',
        entityId: attendance.id,
        description: `Manual attendance for "${student.user.name}"`,
        metadata: {
          studentId: student.id,
          date: targetDate,
          courseId: student.studentCourses[0]?.courseId ?? null,
        },
      },
    });
  }

  await clearAttendanceCache();

  return {
    student: {
      mobile: student.user.mobile,
      name: student.user.name,
      nickname: student.user.nickname,
    },
    attendanceId: attendance.id,
    date: attendance.date,
    checkInAt: attendance.checkInAt,
    status: attendance.status,
    method: attendance.method,
    isFirstCheckIn,
    courseNames: student.studentCourses.map((e) => e.course.name),
    message: isFirstCheckIn
      ? `Attendance marked for ${student.user.name}.`
      : `${student.user.name} was already marked on ${dayjs.utc(targetDate).tz('Asia/Dhaka').format('YYYY-MM-DD')}.`,
  };
};

const getTodayAttendanceFromDB = async (filters: TGetToday) => {
  const { page, limit, skip } = calculatePagination(filters);
  // Shape for Prisma @db.Date — UTC-midnight Date whose UTC date
  // parts equal the BD-local today. `getInstituteToday()` returns
  // BD-midnight absolute time (T18:00Z on BD Oct 8), which would
  // round-trip to the previous day in the @db.Date column.
  const today = instituteLocalDate(new Date());

  /*
   * Build a single `AND` list of student-level predicates so each
   * filter (course, HSC batch, batch day, batch time) composes
   * cleanly. Prisma's relation `some` lets us stack them inside
   * one `student` clause without overwriting each other — the
   * earlier `where.student = { ... }` rewrites made
   * combination filters (e.g. course + batch day) drop one
   * filter on the floor.
   */
  const studentAndClauses: Prisma.StudentWhereInput[] = [{ isDeleted: false }];
  if (filters.courseId) {
    studentAndClauses.push({
      studentCourses: {
        some: { courseId: filters.courseId, isDeleted: false },
      },
    });
  }
  if (filters.hscBatch) {
    studentAndClauses.push({
      batches: {
        some: {
          hscBatch: filters.hscBatch as 'BATCH_25' | 'BATCH_26' | 'BATCH_27' | 'BATCH_28',
          isDeleted: false,
        },
      },
    });
  }
  if (filters.batchTime) {
    studentAndClauses.push({
      batches: {
        some: {
          isDeleted: false,
          batchTime: filters.batchTime as 'TIME_7AM' | 'TIME_4PM',
        },
      },
    });
  }

  const where: Prisma.AttendanceWhereInput = {
    date: today,
    student: { AND: studentAndClauses },
  };

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
    // Re-shape to BD-anchored UTC midnight so the @db.Date filter
    // compares BD calendar days, not whatever UTC date parts the
    // query string happened to encode.
    where.date = {
      ...(params.query.startDate ? { gte: instituteLocalDate(params.query.startDate) } : {}),
      ...(params.query.endDate ? { lte: instituteLocalDate(params.query.endDate) } : {}),
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
  const todayLocal = instituteLocalDate(new Date());

  // Aggregate per-status counts in one round-trip. The (date, status)
  // composite index on Attendance makes this O(matched rows) rather
  // than a full-table scan even on a large attendance history.
  const [monthlyPresent, totalStudents, todayStatusGroups] = await Promise.all([
    prisma.attendance.count({
      where: { date: { gte: startOfMonth, lte: endOfMonth } },
    }),
    prisma.student.count({ where: { isDeleted: false } }),
    prisma.attendance.groupBy({
      by: ['status'],
      where: { date: todayLocal },
      _count: { _all: true },
    }),
  ]);

  const todayByStatus = todayStatusGroups.reduce<Record<string, number>>((acc, g) => {
    acc[g.status] = g._count._all;
    return acc;
  }, {});
  const todayPresent = todayByStatus.PRESENT ?? 0;
  const todayAbsent = todayByStatus.ABSENT ?? 0;

  return {
    monthlyPresent,
    totalActiveStudents: totalStudents,
    todayPresent,
    todayAbsent,
    todayByStatus: {
      PRESENT: todayByStatus.PRESENT ?? 0,
      ABSENT: todayByStatus.ABSENT ?? 0,
    },
  };
};

const deleteAttendanceFromDB = async (id: string, user: JwtPayload) => {
  const existing = await prisma.attendance.findUnique({ where: { id } });
  if (!existing) throw new AppError(httpStatus.NOT_FOUND, 'Attendance record not found');

  // NOTE: deleting an ABSENT row does NOT cause the cron's next
  // tick to re-insert it — slots only fire ONCE at finish time.
  // If the admin wants to swap an ABSENT row for a PRESENT row
  // (e.g. the student DID attend but the scan failed), they should
  // use the manual check-in path, which will reuse the same
  // (studentId, date) slot via the unique index.
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
 * ("opens at 4:00 PM", "closed at 4:05 PM").
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
 * parsed slot. The "current" rule is a 60-min window starting at the
 * slot start (matches a 1-hour class). If nothing is current we
 * return the next upcoming slot (sorted by start time) so the kiosk
 * can pre-announce. If nothing is scheduled today at all we return
 * `{ kind: 'none' }`.
 *
 * Performance: a single round-trip pulls every BatchDay for active
 * courses. For an institute with ~10 active courses and ~20 slots
 * total this is < 1ms of server work, so caching is unnecessary.
 */
const getCurrentBatchFromDB = async (): Promise<TCurrentBatch> => {
  // "now" is anchored to Asia/Dhaka wall-clock time-of-day so the
  // batch schedule (which is configured in BD local time) lines up
  // with what the kiosk clock shows, regardless of where the server
  // is hosted.
  const now = dayjs().tz('Asia/Dhaka');
  const todayMinutes = now.hour() * 60 + now.minute();
  const todayName = weekdayNameForInstitute(now.toDate());

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
      // COMPLETE courses are "inactive" by lifecycle — the
      // kiosk should never surface a slot from a course that's
      // been marked graduated.
      course: { isDeleted: false, status: { not: 'COMPLETE' } },
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
    // as "admit scans" and `false` as "reject scans". Slot
    // states are per-slot and independent; multiple slots
    // can be ON at the same time, but the kiosk only
    // surfaces the slot whose wall-clock window is currently
    // open so the operator never sees a conflict.
    slotEnabled: boolean;
    // Per-slot "check-in window override". When the i-th
    // element is `true`, the kiosk accepts scans for that
    // slot regardless of the wall clock (admin opened the
    // window early for an early arrival, or kept it open
    // past the 5-minute mark). When `false` (or absent), the
    // kiosk uses the default 5-minute window centred on the
    // slot start time.
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

/**
 * Mark ABSENT any student enrolled in a class that just finished and
 * who did not check in. Called by the per-minute cron in
 * `settings/scheduler.ts`.
 *
 * Algorithm:
 *   1. Compute the BD-local "today" (calendar day) and the BD-local
 *      "now" wall-clock time (minutes-since-midnight).
 *   2. Pull every BatchDay row that has the current BD-local weekday
 *      in its `days[]` and belongs to an active, non-deleted course.
 *   3. For each row, walk its `times[]` slots and find any whose
 *      [start_minutes + durationMinutes] fell within the previous
 *      minute (so a class ending at 16:05:00 fires on the 16:05:30
 *      tick — small slack window so we don't miss a tick that
 *      happened to land on the boundary).
 *   4. For each finished slot, find the students enrolled in that
 *      exact (batchDayId, batchTime) slot (i.e. StudentBatch rows
 *      where `isDeleted = false`).
 *   5. Filter to students whose (studentId, BD-today) tuple has NO
 *      existing Attendance row — covers both real check-ins (PRESENT)
 *      and admin manual entries (also PRESENT).
 *   6. Insert ABSENT rows in bulk with `skipDuplicates: true` so a
 *      concurrent tick (or a re-run after a crash) can't produce two
 *      rows for the same (studentId, date) — the unique index
 *      enforces it at the DB layer too.
 *
 * Returns a small summary so the scheduler can log diagnostics.
 *
 * Idempotency is two-layered:
 *   - In-process: the caller (scheduler) holds a fire-key latch on
 *     `(courseId, slotIndex, BD-date)` so the same slot isn't
 *     re-processed within the same process lifetime. The latch is
 *     deliberately NOT persisted — on process restart the cron
 *     resumes from the next minute slot, and a slot that fired in
 *     a previous lifetime has already had its ABSENT rows written
 *     (and the unique constraint would reject any duplicate).
 *   - At the DB: `@@unique([studentId, date])` plus
 *     `createMany({ skipDuplicates: true })` makes the operation
 *     idempotent even if a slow tick overlaps a fast restart.
 */
const markAbsenteesForFinishedSlotsToDB = async (): Promise<{
  scanned: number;
  inserted: number;
  slots: number;
}> => {
  const nowBd = dayjs().tz('Asia/Dhaka');
  const todayLocal = new Date(Date.UTC(nowBd.year(), nowBd.month(), nowBd.date()));
  const nowMinutes = nowBd.hour() * 60 + nowBd.minute();
  const todayName = weekdayNameForInstitute(nowBd.toDate());

  // Pre-window: how far back to look for "just finished" slots. A
  // 60-second window covers the previous minute cleanly even when
  // the cron tick lands a few seconds past the boundary. A wider
  // window (e.g. 5 minutes) would re-process slots that already
  // fired; narrower would risk missing boundary cases.
  const PRE_WINDOW_MIN = 1;

  const batcDays = await prisma.batchDay.findMany({
    where: {
      days: { has: todayName },
      // COMPLETE courses are "inactive" by lifecycle — the
      // absent-marking cron should never stamp rows for a
      // course that's already graduated.
      course: { isDeleted: false, status: { not: 'COMPLETE' } },
    },
    select: {
      id: true,
      courseId: true,
      course: { select: { name: true } },
      times: true,
      durationMinutes: true,
    },
  });

  let totalInserted = 0;
  let totalScanned = 0;
  let slotsProcessed = 0;

  for (const bd of batcDays) {
    for (let slotIdx = 0; slotIdx < bd.times.length; slotIdx++) {
      const slotTime = bd.times[slotIdx];
      const startMin = parseTimeOfDay(slotTime);
      if (startMin === null) continue;
      const endMin = startMin + bd.durationMinutes;

      // Slot finishes when its end crosses the now mark. The window
      // catches slots whose end is between (nowMinutes - 1) and
      // (nowMinutes + small epsilon). We use strict "<= nowMin" AND
      // "> nowMin - 1" so a slot ending at exactly nowMin fires
      // once — the upper bound is inclusive of the current minute,
      // the lower bound excludes anything the previous minute already
      // handled.
      if (endMin > nowMinutes) continue;
      if (endMin < nowMinutes - PRE_WINDOW_MIN) continue;
      slotsProcessed += 1;

      // Students enrolled in this exact (batchDayId, batchTime).
      // Multiple students can map to the same slot — the createMany
      // bulk-insert keeps the round-trip count O(slots) instead of
      // O(students).
      const enrolled = await prisma.studentBatch.findMany({
        where: {
          batchDayId: bd.id,
          batchTime: slotTime,
          isDeleted: false,
          student: { isDeleted: false },
        },
        select: { studentId: true },
      });
      if (enrolled.length === 0) continue;
      totalScanned += enrolled.length;

      // Filter to students with no existing Attendance row for
      // today. Single query — fetch existing rows for these
      // students on today's BD date, then subtract.
      const studentIds = enrolled.map((e) => e.studentId);
      const existing = await prisma.attendance.findMany({
        where: {
          studentId: { in: studentIds },
          date: todayLocal,
        },
        select: { studentId: true },
      });
      const coveredIds = new Set(existing.map((e) => e.studentId));
      const absentCandidates = studentIds.filter((id) => !coveredIds.has(id));
      if (absentCandidates.length === 0) continue;

      // `method: ADMIN` — there's no scanner involved; the row is
      // system-generated. Keeps the existing AttendanceMethod enum
      // (NFC/MANUAL/ADMIN) as-is and avoids introducing a new
      // "SYSTEM" value. `recordedBy` is left null because the
      // initiator is the SYSTEM cron, not a human actor.
      // `checkInAt` is the actual end-of-class wall-clock instant
      // so the audit trail shows when the ABSENT decision was made.
      const result = await prisma.attendance.createMany({
        data: absentCandidates.map((studentId) => ({
          studentId,
          date: todayLocal,
          status: 'ABSENT' as const,
          method: AttendanceMethod.ADMIN,
          deviceId: null,
          recordedBy: null,
          checkInAt: nowBd.toDate(),
        })),
        skipDuplicates: true,
      });
      totalInserted += result.count;
    }
  }

  return { scanned: totalScanned, inserted: totalInserted, slots: slotsProcessed };
};

export const AttendanceService = {
  checkInStudentToDB,
  manualCheckInToDB,
  getTodayAttendanceFromDB,
  getStudentAttendanceFromDB,
  getAttendanceStatsFromDB,
  deleteAttendanceFromDB,
  getCurrentBatchFromDB,
  markAbsenteesForFinishedSlotsToDB,
};
