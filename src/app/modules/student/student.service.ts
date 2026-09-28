import httpStatus from 'http-status';
import bcrypt from 'bcrypt';
import dayjs from 'dayjs';
import { Prisma } from '@prisma/client';
import prisma from '../../utils/prisma';
import AppError from '../../errors/AppError';
import config from '../../config';
import generateStudentId from '../../utils/generateStudentId';
import { TAdmitStudent, TUpdateStudent, TGetAllStudents } from './student.validation';
import calculatePagination from '../../utils/calculatePagination';
import { clearStudentCache } from '../../utils/clearCache';
import { JwtPayload } from 'jsonwebtoken';

/**
 * Narrow payload used when an admin enrolls an EXISTING student into a
 * NEW course. Distinct from `TAdmitStudent` (which is for fresh admits
 * and carries the full personal / guardian / address / SSC block).
 * Defined inline rather than imported from `student.validation.ts` so
 * the service module has no circular deps with the schema module — the
 * route layer imports the Zod schema for validation, and the service
 * consumes the parsed type.
 */
export type TEnrollExistingStudent = {
  mobile: string;
  courseId: string;
  batchDayId: string;
  batchTime: string;
  nickname?: string;
};

/**
 * Convert a Date to the English weekday name (`Sunday` … `Saturday`) that
 * `BatchDay.days[]` is expected to contain. The check-batch-conflict util
 * stores the raw user-entered string (case-preserving), so we lowercase
 * the comparison on the call site — this helper just normalises the JS
 * output for direct array membership tests.
 */
const weekdayNameFor = (d: Date): string =>
  ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
    d.getDay()
  ];

/**
 * Normalise an optional stringly-typed payload field to a real `null`
 * when it's missing or empty. Used for the now-optional Student
 * fields (mother block, village, etc.) so the DB column is stored as
 * `NULL` instead of an empty string — keeps exports / analytics sane.
 * Generic over the input shape so each call site keeps its narrow
 * type (BloodGroup / string / number) instead of widening to
 * `string | number | null`.
 */
const nullIfEmpty = <T,>(v: T | undefined | null): T | null => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  return v as T;
};

/**
 * Treat truthy query values uniformly. The validateRequest middleware
 * only validates the parsed Zod result and discards it, so the raw
 * URL-encoded string ("true" / "1") reaches the service even though the
 * schema's *output* type is `boolean`. Compare against the common truthy
 * shapes here so scenario toggles like `hasDue` and `activeCoursesOnly`
 * actually take effect.
 */
const isTruthyQuery = (v: unknown): boolean =>
  v === true || v === 'true' || v === '1' || v === 1;

const studentInclude = {
  user: {
    select: {
      id: true,
      studentId: true,
      name: true,
      nickname: true,
      status: true,
      mustChangePassword: true,
      createdAt: true,
    },
  },
  studentCourses: {
    where: { isDeleted: false },
    // Explicit scalar select so `studentCourseId` (per-enrollment ID
    // like "271200") is guaranteed on the wire — needed by the
    // students list table to render one row per active enrollment.
    // Without an explicit select, Prisma already returns it, but
    // spelling it out here keeps the contract obvious for future
    // maintainers and pairs naturally with the type-side field.
    select: {
      id: true,
      studentCourseId: true,
      courseId: true,
      enrolledAt: true,
      isCompleted: true,
      completedAt: true,
      status: true,
      course: true,
      payments: { where: { isDeleted: false }, select: { amount: true } },
    },
  },
  batches: {
    where: { isDeleted: false },
    include: { batchDayRel: true },
  },
  payments: {
    where: { isDeleted: false },
    select: {
      id: true,
      studentId: true,
      studentCourseId: true,
      amount: true,
      method: true,
      paidAt: true,
    },
  },
} satisfies Prisma.StudentInclude;

/**
 * Count active (non-deleted) enrollments for a single (batchDay, batchTime)
 * slot. Used by the seat-cap gate inside `resolveBatchDayForCourse`.
 *
 * Each student admitted to a slot creates exactly one `StudentBatch`
 * row linking them to `(batchDayId, batchTime)`. Counting those rows
 * scoped to the slot gives the live enrollment count for that slot —
 * which is the unit the user clarified the cap applies to
 * (Course.totalSeats means "seats per slot", not "seats per course").
 *
 * Mirrors the soft-delete filter used elsewhere in this module
 * (`studentInclude` below) so deleted enrollments don't lock seats
 * indefinitely.
 */
const countEnrolledForSlot = async (
  tx: Prisma.TransactionClient,
  batchDayId: string,
  batchTime: string,
): Promise<number> => {
  return tx.studentBatch.count({
    where: {
      batchDayId,
      batchTime,
      isDeleted: false,
      student: { isDeleted: false },
    },
  });
};

/**
 * Validate that the selected batch day + time belong to the chosen course.
 * Returns the matched BatchDay row so the caller can reuse it for the
 * `StudentBatch` write without re-querying. Shared by the admit path and
 * the existing-student enrollment path so both enforce the same invariant.
 *
 * Also enforces the per-course seat cap (Course.totalSeats): a SELECT …
 * FOR UPDATE on the Course row serializes concurrent admits so the
 * cap cannot be exceeded by a race.
 */
const resolveBatchDayForCourse = async (
  tx: Prisma.TransactionClient,
  courseId: string,
  batchDayId: string,
  batchTime: string,
) => {
  // Pessimistic lock on the Course row. The lock is held until the
  // outer transaction commits, so a concurrent admit that started one
  // millisecond later will block here until our count + insert finish.
  // This is the strongest defence against two admins admitting the
  // (cap+1)th student simultaneously.
  await tx.$queryRaw`SELECT id FROM courses WHERE id = ${courseId} FOR UPDATE`;

  const course = await tx.course.findUnique({
    where: { id: courseId },
    include: { batchDays: { orderBy: { position: 'asc' } } },
  });
  if (!course || course.isDeleted) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Selected course not found');
  }
  if (!course.isActive) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Selected course is not active');
  }
  // A course marked complete by the admin has "graduated" — no new
  // admits or re-enrollments are allowed. The frontend filters
  // completed courses out of the picker, but we still guard here so a
  // stale form payload (cached before the toggle) can't slip through.
  if (course.isCompleted) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Selected course has been marked as completed and is no longer accepting enrollments. Re-open it from the Courses page first.',
    );
  }

  const matchingBatchDay = course.batchDays.find((d) => d.id === batchDayId);
  if (!matchingBatchDay) {
    throw new AppError(httpStatus.BAD_REQUEST, `Selected batch day does not belong to this course`);
  }
  if (!matchingBatchDay.times.includes(batchTime)) {
    throw new AppError(httpStatus.BAD_REQUEST, `Selected time is not offered for this batch day`);
  }

  // Seat-cap gate. NULL totalSeats = uncapped; otherwise refuse when
  // the live enrollment count for THIS SLOT (batchDay + batchTime)
  // has hit the cap. Slots are independent: a course with two batch
  // days × two times = four slots, each with its own quota. The cap
  // (`Course.totalSeats`) is set on the Courses page; the per-slot
  // count is derived from `StudentBatch` rows.
  if (course.totalSeats != null) {
    const enrolled = await countEnrolledForSlot(
      tx,
      matchingBatchDay.id,
      batchTime,
    );
    if (enrolled >= course.totalSeats) {
      throw new AppError(
        httpStatus.CONFLICT,
        `Slot "${matchingBatchDay.name}" at ${batchTime} is full (${enrolled}/${course.totalSeats} seats taken). Pick another slot or increase the cap on the Courses page.`,
      );
    }
  }

  return { course, matchingBatchDay };
};

/**
 * Enroll an EXISTING student (matched by phone) into a NEW course.
 * The User/Student rows are reused verbatim — no new credentials are
 * minted, the student's existing login (mobile) keeps working.
 *
 * Returns the same shape as `admitStudentToDB`'s reuse branch so the
 * controller can render the existing `alreadyEnrolled` credentials card
 * without branching on which endpoint produced the response.
 *
 * Throws:
 *   - 404 if no active student profile exists for the given mobile.
 *   - 409 if the student is already enrolled in this course.
 *   - 400 if the batch day / time don't belong to the chosen course.
 */
const enrollExistingStudentToDB = async (
  payload: TEnrollExistingStudent,
  user: JwtPayload,
) => {
  // Wrap the entire body in a single transaction so the seat-cap gate's
  // SELECT … FOR UPDATE lock is held until the StudentCourse +
  // StudentBatch writes commit. resolveBatchDayForCourse requires `tx`
  // so the lock and the count participate in the same connection.
  return prisma.$transaction(async (tx) => {
    const { course, matchingBatchDay } = await resolveBatchDayForCourse(
      tx,
      payload.courseId,
      payload.batchDayId,
      payload.batchTime,
    );

    const existingStudent = await tx.student.findFirst({
      where: { mobile: payload.mobile, isDeleted: false },
      include: { user: true },
    });
    if (!existingStudent) {
      throw new AppError(
        httpStatus.NOT_FOUND,
        'No active student profile found for this mobile number',
      );
    }

    // Guard against double-enrolment in the SAME course. The unique
    // index on (studentId, courseId) would catch this anyway, but
    // surfacing a friendly error makes the admin's intent clearer.
    const alreadyEnrolled = await tx.studentCourse.findFirst({
      where: {
        studentId: existingStudent.id,
        courseId: course.id,
        isDeleted: false,
      },
    });
    if (alreadyEnrolled) {
      throw new AppError(
        httpStatus.CONFLICT,
        'This student is already enrolled in this course',
      );
    }

    // Gate: a student may not enroll in another course while they have
    // an active enrollment in a course whose batch is not yet marked
    // complete. Without this, a student could be in HSC_1ST_YEAR and
    // HSC_2ND_YEAR simultaneously, which is what the user explicitly
    // wants to forbid ("can enroll another course after finished the
    // current course"). We surface the blocking course name(s) in the
    // error so the admin knows exactly which one to mark complete.
    const blockingEnrollments = await tx.studentCourse.findMany({
      where: {
        studentId: existingStudent.id,
        isDeleted: false,
        courseId: { not: course.id },
        course: { isCompleted: false },
      },
      select: { course: { select: { name: true } } },
    });
    if (blockingEnrollments.length > 0) {
      const names = blockingEnrollments
        .map((e) => e.course.name)
        .filter((n, i, arr) => arr.indexOf(n) === i) // unique
        .join(', ');
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Cannot enroll: this student still has an active enrollment in ${names}, which has not been marked as completed yet. Mark the course(s) as complete first, then retry.`,
      );
    }

    // Generate the per-enrollment ID using the new course's
    // hscBatch+name (roll is global per prefix, not per student).
    const newStudentCourseId = await generateStudentId(course.hscBatch, course.name);

    const enrollment = await tx.studentCourse.create({
      data: {
        studentId: existingStudent.id,
        courseId: course.id,
        enrolledBy: user.userId,
        studentCourseId: newStudentCourseId,
      },
      include: { course: true },
    });

    await tx.studentBatch.create({
      data: {
        studentId: existingStudent.id,
        batchDay: matchingBatchDay.name as string,
        batchDayId: matchingBatchDay.id,
        batchTime: payload.batchTime,
        hscBatch: course.hscBatch,
      },
    });

    // Optional nickname update — keep the field editable so admins can
    // fix a typo without going through the full student-edit flow.
    if (payload.nickname && payload.nickname !== existingStudent.user.nickname) {
      await tx.user.update({
        where: { id: existingStudent.userId },
        data: { nickname: payload.nickname },
      });
    }

    await tx.activityLog.create({
      data: {
        actorId: user.userId,
        actorRole: user.role as 'SUPER_ADMIN' | 'ADMIN',
        action: 'STUDENT_ENROLLED_IN_NEW_COURSE',
        entityType: 'StudentCourse',
        entityId: enrollment.id,
        description: `Existing student "${existingStudent.user.name}" (${existingStudent.user.studentId}) enrolled in "${course.name}"`,
        metadata: {
          studentId: existingStudent.id,
          courseId: course.id,
          courseName: course.name,
          hscBatch: course.hscBatch,
          studentCourseId: newStudentCourseId,
        },
      },
    });

    const result = await tx.student.findUnique({
      where: { id: existingStudent.id },
      include: studentInclude,
    });

    await clearStudentCache();

    return {
      student: result,
      // Reuse-case: no new credentials are generated. The student's
      // existing login (mobile) keeps working unchanged.
      initialPassword: null as string | null,
      studentId: existingStudent.user.studentId,
      studentCourseId: newStudentCourseId,
      alreadyEnrolled: true as const,
    };
  });
};

const admitStudentToDB = async (payload: TAdmitStudent, user: JwtPayload) => {
  // Cheap pre-fetch of just the scalars needed for the per-enrollment
  // ID generation that happens BEFORE we open the transaction. We do
  // NOT take the seat-cap lock here — the authoritative gate runs
  // inside the transaction below, with the same `course.id`.
  const courseMeta = await prisma.course.findUnique({
    where: { id: payload.courseId },
    select: { hscBatch: true, name: true },
  });
  if (!courseMeta || courseMeta.name === null) {
    // Should never happen — `resolveBatchDayForCourse` re-checks inside
    // the tx — but a quick guard avoids a confusing null reference.
    throw new AppError(httpStatus.BAD_REQUEST, 'Selected course not found');
  }

  // Detect an existing ACTIVE student profile by phone. If found, we
  // delegate to `enrollExistingStudentToDB` so the reuse logic lives in
  // exactly one place — both the admit endpoint and the dedicated
  // `/student/enroll-existing` endpoint share it.
  // The reuse branch opens its own transaction and runs the seat-cap
  // gate inside it; we don't pre-lock here so the unused lock isn't
  // held across the network round-trip to detect the existing student.
  const existingStudent = await prisma.student.findFirst({
    where: { mobile: payload.mobile, isDeleted: false },
    select: { id: true },
  });
  if (existingStudent) {
    return enrollExistingStudentToDB(
      {
        mobile: payload.mobile,
        courseId: payload.courseId,
        batchDayId: payload.batchDayId,
        batchTime: payload.batchTime,
      },
      user,
    );
  }

  // ── Fresh admit path ──────────────────────────────────────────────
  // First time this phone number is on file — create User, Student,
  // and the first StudentCourse + StudentBatch atomically.
  const studentId = await generateStudentId(courseMeta.hscBatch, courseMeta.name);
  // The initial password is the freshly-generated studentId (e.g. "271206"
  // for HSC batch 27, year 1, roll 206). On first sign-in the student is
  // forced through the change-password flow (`User.mustChangePassword`
  // is set true below) — they cannot use any feature until the password
  // is changed. The same studentId is stamped on the StudentCourse row
  // (`studentCourseId`) below, so the login handle and the displayed
  // course-specific ID match exactly. Re-using the studentId also lets
  // the admin hand the printed credentials card straight to the student
  // — one number, one password, no second lookup required.
  const initialPassword = studentId;
  const hashedPassword = await bcrypt.hash(initialPassword, Number(config.bcryptSaltRounds) || 12);

  const student = await prisma.$transaction(async (tx) => {
    // Run the seat-cap gate (with its FOR UPDATE lock) INSIDE this
    // transaction so the lock is held until the StudentCourse write
    // commits. Without this, a concurrent admit could squeeze through
    // between the gate and the insert and over-fill the course.
    const { course, matchingBatchDay } = await resolveBatchDayForCourse(
      tx,
      payload.courseId,
      payload.batchDayId,
      payload.batchTime,
    );
    const newUser = await tx.user.create({
      data: {
        studentId,
        mobile: payload.mobile,
        name: payload.name,
        nickname: payload.nickname,
        password: hashedPassword,
        role: 'STUDENT',
        mustChangePassword: true,
        passwordLevel: 0,
      },
    });

    const newStudent = await tx.student.create({
      data: {
        userId: newUser.id,
        college: payload.college,
        mobile: payload.mobile,
        // Optional personal/guardian fields. `nullIfEmpty` normalises
        // missing OR empty-string into a real `null` so the DB column
        // is cleanly nullable (instead of storing `""` everywhere).
        bloodGroup: nullIfEmpty(payload.bloodGroup),
        fatherName: payload.fatherName,
        fatherOccupation: payload.fatherOccupation,
        fatherMobile: payload.fatherMobile,
        motherName: nullIfEmpty(payload.motherName),
        motherOccupation: nullIfEmpty(payload.motherOccupation),
        motherMobile: nullIfEmpty(payload.motherMobile),
        addressVillage: nullIfEmpty(payload.addressVillage),
        addressPostOffice: nullIfEmpty(payload.addressPostOffice),
        addressUpozila: payload.addressUpozila,
        addressDistrict: payload.addressDistrict,
        sscInstitute: payload.sscInstitute,
        sscBoard: nullIfEmpty(payload.sscBoard),
        sscPassingYear: nullIfEmpty(payload.sscPassingYear),
        // Decimal must be wrapped — guard against null/undefined before
        // constructing (Prisma.Decimal(null) throws).
        sscGpa:
          payload.sscGpa === undefined || payload.sscGpa === null
            ? null
            : new Prisma.Decimal(payload.sscGpa),
        admittedBy: user.userId,
      },
    });

    await tx.studentCourse.create({
      data: {
        studentId: newStudent.id,
        courseId: course.id,
        enrolledBy: user.userId,
        // First enrollment reuses the User.studentId (also generated
        // from this course's hscBatch+name) so existing display
        // expectations are preserved.
        studentCourseId: studentId,
      },
    });

    await tx.studentBatch.create({
      data: {
        studentId: newStudent.id,
        // Use the name of the selected batch day.
        batchDay: matchingBatchDay.name as string,
        // Also link the FK so the cascading filter works.
        batchDayId: matchingBatchDay.id,
        batchTime: payload.batchTime,
        hscBatch: course.hscBatch,
      },
    });

    await tx.activityLog.create({
      data: {
        actorId: user.userId,
        actorRole: user.role as 'SUPER_ADMIN' | 'ADMIN',
        action: 'STUDENT_ADMITTED',
        entityType: 'Student',
        entityId: newStudent.id,
        description: `Student "${payload.name}" admitted (${studentId})`,
        metadata: {
          studentId,
          courseId: course.id,
          courseName: course.name,
          hscBatch: course.hscBatch,
        },
      },
    });

    return tx.student.findUnique({
      where: { id: newStudent.id },
      include: studentInclude,
    });
  });

  await clearStudentCache();

  return {
    student,
    initialPassword,
    studentId,
    studentCourseId: studentId,
    newEnrollmentId: undefined,
    alreadyEnrolled: false as const,
  };
};

const getAllStudentsFromDB = async (
  filters: TGetAllStudents,
  options: { page?: number; limit?: number; sortBy?: string; sortOrder?: 'asc' | 'desc' },
) => {
  const { page, limit, skip, sortBy, sortOrder } = calculatePagination(options);
  // Pull every known query key out of `filters` so the SMS scenario keys
  // (classDate, classTime, scenarioCourses, hasDue, activeCoursesOnly) and
  // the legacy fields don't leak into `rest` and end up passed to Prisma
  // as raw `where: { classDate: "..." }` clauses — Prisma rejects unknown
  // argument names with "Unknown argument `classDate`".
  const {
    searchTerm,
    hscBatch,
    courseId,
    batchDay,
    batchDayId,
    batchTime,
    district,
    classDate,
    classTime,
    scenarioCourses,
    hasDue,
    activeCoursesOnly,
    absentOnDate,
    // The absent-warning picker + run-now pass `limit`/`page` inside
    // `filters` (not just in `options`); strip them so they don't slip
    // into the WHERE clause as raw where-input keys.
    page: _pageFromFilters,
    limit: _limitFromFilters,
    sortBy: _sortByFromFilters,
    sortOrder: _sortOrderFromFilters,
    ...rest
  } = filters;

  // console.log('filters:', filters);
  // console.log('options:', options);

  const andConditions: Prisma.StudentWhereInput[] = [{ isDeleted: false }];

  if (searchTerm) {
    andConditions.push({
      OR: [
        { mobile: { contains: searchTerm, mode: 'insensitive' } },
        { addressDistrict: { contains: searchTerm, mode: 'insensitive' } },
        { user: { is: { name: { contains: searchTerm, mode: 'insensitive' } } } },
        { user: { is: { nickname: { contains: searchTerm, mode: 'insensitive' } } } },
        { user: { is: { studentId: { contains: searchTerm, mode: 'insensitive' } } } },
      ],
    });
  }

  if (hscBatch) {
    andConditions.push({
      batches: { some: { hscBatch, isDeleted: false } },
    });
  }

  if (courseId) {
    andConditions.push({
      studentCourses: { some: { courseId, isDeleted: false } },
    });
  }

  if (batchDayId) {
    // Filter by the specific BatchDay row (e.g. "Weekend" / "Weekday")
    // using the StudentBatch.batchDayId foreign key. The chosen day and
    // time correspondence is preserved.
    andConditions.push({
      batches: {
        some: {
          batchDayId,
          isDeleted: false,
        },
      },
    });
  }

  if (batchDay || batchTime) {
    // When `courseId` is also set, scope the batch to this course via
    // the FK relation — a student enrolled in multiple courses must
    // satisfy the time/day filter on a batch in the chosen course.
    // Otherwise, the legacy single-course students page filter keeps
    // its looser behaviour (any batch matches).
    const batchWhere: Prisma.StudentBatchWhereInput = {
      isDeleted: false,
      ...(courseId ? { batchDayRel: { courseId } } : {}),
    };
    if (batchDay) batchWhere.batchDay = batchDay;
    if (batchTime) batchWhere.batchTime = batchTime;
    andConditions.push({ batches: { some: batchWhere } });
  }

  // ---------------------------------------------------------------------
  // SMS scenario filters. All four are additive with the existing filter
  // chain — combining them with the rest is what produces e.g. "students
  // who have class on Saturday AND have an unpaid enrollment AND are in
  // HSC 1st Year".
  // ---------------------------------------------------------------------

  // (a) Class-date + optional class-time, AND class-time-only.
  //
  //     Class-date resolves to a weekday, then we look up BatchDay rows
  //     whose `days[]` contains that weekday (case-insensitive — Prisma's
  //     `has` is exact-match on Postgres text-array elements).
  //     Class-time is matched against the student's actual enrollment
  //     time (`StudentBatch.batchTime`), NOT the parent `BatchDay.times[]`
  //     catalog — otherwise a BatchDay with times=["4:00 PM","10:00 AM"]
  //     would falsely return a student enrolled at 4:00 PM when the user
  //     filters for 10:00 AM.
  //
  //     The two filters are independent: classTime alone works (just
  //     narrows by enrollment time across all batches), classDate alone
  //     works (just narrows by weekday), and combining them intersects
  //     both. Empty classDate-match is short-circuited via
  //     `id: { in: [] }`.
  if (classDate || classTime) {
    // `classDate` reaches us as the raw string from req.query because the
    // validateRequest middleware only validates and discards the parsed
    // result. Coerce here so weekdayNameFor (which calls .getDay()) doesn't
    // crash with "d.getDay is not a function" when the frontend passes an
    // ISO yyyy-mm-dd string.
    const classDateObj = classDate
      ? classDate instanceof Date
        ? classDate
        : new Date(classDate)
      : null;

    let matchingBatchDayIds: string[] | null = null;
    if (classDateObj) {
      const weekday = weekdayNameFor(classDateObj);
      const matchingBatchDays = await prisma.batchDay.findMany({
        // When `courseId` is also set, restrict the lookup to that
        // course's BatchDay rows. Otherwise look up across all courses.
        where: {
          course: { isDeleted: false, ...(courseId ? { id: courseId } : {}) },
        },
        select: { id: true, days: true },
      });
      const lowerWeekday = weekday.toLowerCase();
      matchingBatchDayIds = matchingBatchDays
        .filter((b) =>
          b.days.some((d) => d.toLowerCase() === lowerWeekday),
        )
        .map((b) => b.id);
    }

    // Build a single StudentBatch constraint that AND-combines all of:
    //   - the matched BatchDay ids (from classDate), if any
    //   - the chosen classTime, if any
    //   - isDeleted: false
    //   - when `courseId` is also set, scope the batch to that course
    //     so a student enrolled in multiple courses only matches if
    //     one of those batches is in the chosen course.
    // When classDate yields zero matches we short-circuit the whole
    // query by adding `id: { in: [] }` — there's no student whose
    // batches include a non-existent BatchDay.
    if (matchingBatchDayIds !== null && matchingBatchDayIds.length === 0) {
      andConditions.push({ id: { in: [] } });
    } else {
      const batchWhere: Prisma.StudentBatchWhereInput = {
        isDeleted: false,
        ...(courseId ? { batchDayRel: { courseId } } : {}),
        ...(matchingBatchDayIds !== null
          ? { batchDayId: { in: matchingBatchDayIds } }
          : {}),
        ...(classTime ? { batchTime: classTime } : {}),
      };
      andConditions.push({ batches: { some: batchWhere } });
    }
  }

  // (b) Multi-course scenario. CSV of UUIDs → studentCourses matches any.
  //     Overrides the single `courseId` filter when both are present, since
  //     a user explicitly selecting "1st + 2nd year" should ignore any
  //     single-course filter.
  if (scenarioCourses) {
    const ids = scenarioCourses
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length > 0) {
      andConditions.push({
        studentCourses: { some: { courseId: { in: ids }, isDeleted: false } },
      });
    }
  }

  // (c) Has-due filter (StudentCourse.status != PAID). Mirrors the rule
  //     used by `getDuePaymentsFromDB` so the SMS picker and the Due
  //     Payments page agree on what "due" means.
  if (isTruthyQuery(hasDue)) {
    andConditions.push({
      studentCourses: {
        some: { isDeleted: false, status: { not: 'PAID' } },
      },
    });
  }

  // (d) Active-courses-only filter.
  if (isTruthyQuery(activeCoursesOnly)) {
    andConditions.push({
      studentCourses: {
        some: {
          isDeleted: false,
          course: { isActive: true, isDeleted: false },
        },
      },
    });
  }

  // (e) Absent-on-date filter — feeds the absent-warning SMS picker.
  //     Resolves to "expected students on this weekday minus students
  //     with an Attendance row on this exact date". Implemented in two
  //     passes because the cohort + present subtraction cross-tables,
  //     and a single `NOT EXISTS` against `attendance` would fail to
  //     account for the "expected" half (the student only counts as
  //     absent if they were enrolled in a class that day).
  if (absentOnDate) {
    const targetDate = dayjs(absentOnDate).startOf('day').toDate();
    const weekday = weekdayNameFor(targetDate);
    // (e.1) Narrow cohort to students with a batch on this weekday.
    const matchingBatchDays = await prisma.batchDay.findMany({
      where: {
        days: { has: weekday },
        course: { isDeleted: false },
      },
      select: { id: true, days: true },
    });
    const lowerWeekday = weekday.toLowerCase();
    const batchDayIds = matchingBatchDays
      .filter((b) => b.days.some((d) => d.toLowerCase() === lowerWeekday))
      .map((b) => b.id);
    if (batchDayIds.length === 0) {
      andConditions.push({ id: { in: [] } });
    } else {
      andConditions.push({
        batches: { some: { batchDayId: { in: batchDayIds }, isDeleted: false } },
      });
    }
    // (e.2) Subtract present. We use `NOT` on a where-clause against
    //       Attendance — Prisma compiles this to a NOT EXISTS subquery.
    andConditions.push({
      NOT: {
        attendance: { some: { date: targetDate } },
      },
    });
  }

  if (district) {
    andConditions.push({
      addressDistrict: { contains: district, mode: 'insensitive' },
    });
  }

  if (Object.keys(rest).length > 0) {
    andConditions.push({
      AND: Object.entries(rest).map(([k, v]) => ({ [k]: v }) as Prisma.StudentWhereInput),
    });
  }

  const where: Prisma.StudentWhereInput = { AND: andConditions };

  const orderBy: Prisma.StudentOrderByWithRelationInput = sortBy
    ? ({ [sortBy]: sortOrder } as Prisma.StudentOrderByWithRelationInput)
    : { createdAt: 'desc' };

  const [data, total] = await Promise.all([
    prisma.student.findMany({
      where,
      skip,
      take: limit,
      orderBy,
      include: studentInclude,
    }),
    prisma.student.count({ where }),
  ]);

  // Derive a per-student paymentStatus from the persisted StudentCourse.status
  // values (NOT from a recomputation against fee/payments), so manual status
  // overrides — both historical and from the override-status field on
  // record-payment — are respected. A student with no active enrollments
  // is PENDING. If every active enrollment is PAID, the student is PAID. If
  // any is PARTIAL (and none is PAID), the student is PARTIAL. Otherwise
  // PENDING. This mirrors the dashboard's bucketing rules.
  const dataWithStatus = data.map((s) => {
    const enrollments = s.studentCourses ?? [];
    const totalFee = enrollments.reduce(
      (sum, sc) => sum + Number(sc.course?.fee ?? 0),
      0,
    );
    const totalPaid = enrollments.reduce(
      (sum, sc) =>
        sum +
        (sc.payments ?? []).reduce((p, pay) => p + Number(pay.amount), 0),
      0,
    );
    const totalDue = Math.max(0, totalFee - totalPaid);
    const activeStatuses = enrollments.map(
      (sc) => sc.status as 'PENDING' | 'PARTIAL' | 'PAID',
    );
    const status: 'PENDING' | 'PARTIAL' | 'PAID' =
      activeStatuses.length === 0
        ? 'PENDING'
        : activeStatuses.every((st) => st === 'PAID')
        ? 'PAID'
        : activeStatuses.some((st) => st === 'PARTIAL')
        ? 'PARTIAL'
        : 'PENDING';
    const coursePaymentStatuses = enrollments.map((sc) => ({
      studentCourseId: sc.id,
      courseName: sc.course?.name ?? 'Course',
      status: sc.status as 'PENDING' | 'PARTIAL' | 'PAID',
    }));
    return {
      ...s,
      paymentStatus: status,
      paymentSummary: { totalFee, totalPaid, totalDue },
      coursePaymentStatuses,
    };
  });

  return {
    meta: { page, limit, total },
    data: dataWithStatus,
  };
};

const getStudentByIdFromDB = async (id: string) => {
  const student = await prisma.student.findUnique({
    where: { id, isDeleted: false },
    include: {
      ...studentInclude,
      payments: {
        where: { isDeleted: false },
        include: {
          studentCourse: { include: { course: true } },
        },
        orderBy: { createdAt: 'desc' },
      },
      attendance: {
        orderBy: { date: 'desc' },
        take: 30,
      },
    },
  });
  if (!student) throw new AppError(httpStatus.NOT_FOUND, 'Student not found');

  // Derive paymentStatus from the persisted StudentCourse.status values
  // (NOT from a recomputation against fee/payments) so manual status
  // overrides are reflected. See getAllStudentsFromDB for the full
  // bucketing rules.
  const enrollments = student.studentCourses ?? [];
  const totalFee = enrollments.reduce(
    (sum, sc) => sum + Number(sc.course.fee),
    0,
  );
  const totalPaid = enrollments.reduce(
    (sum, sc) =>
      sum +
      (sc.payments ?? []).reduce((p, pay) => p + Number(pay.amount), 0),
    0,
  );
  const totalDue = Math.max(0, totalFee - totalPaid);
  const activeStatuses = enrollments.map(
    (sc) => sc.status as 'PENDING' | 'PARTIAL' | 'PAID',
  );
  const status: 'PENDING' | 'PARTIAL' | 'PAID' =
    activeStatuses.length === 0
      ? 'PENDING'
      : activeStatuses.every((st) => st === 'PAID')
      ? 'PAID'
      : activeStatuses.some((st) => st === 'PARTIAL')
      ? 'PARTIAL'
      : 'PENDING';
  const coursePaymentStatuses = enrollments.map((sc) => ({
    studentCourseId: sc.id,
    courseName: sc.course.name,
    status: sc.status as 'PENDING' | 'PARTIAL' | 'PAID',
  }));
  return {
    ...student,
    paymentStatus: status,
    paymentSummary: { totalFee, totalPaid, totalDue },
    coursePaymentStatuses,
  };
};

const updateStudentInDB = async (id: string, payload: TUpdateStudent['body'], user: JwtPayload) => {
  const existing = await prisma.student.findUnique({ where: { id } });
  if (!existing) throw new AppError(httpStatus.NOT_FOUND, 'Student not found');

  const data: Prisma.StudentUpdateInput = {};
  if (payload.college !== undefined) data.college = payload.college;
  if (payload.mobile !== undefined) data.mobile = payload.mobile;
  if (payload.bloodGroup !== undefined) data.bloodGroup = payload.bloodGroup;
  if (payload.fatherName !== undefined) data.fatherName = payload.fatherName;
  if (payload.fatherOccupation !== undefined) data.fatherOccupation = payload.fatherOccupation;
  if (payload.fatherMobile !== undefined) data.fatherMobile = payload.fatherMobile;
  // Optional / nullable fields use `nullIfEmpty` so missing OR empty-
  // string payloads both clear the column (rather than storing "").
  if (payload.motherName !== undefined) data.motherName = nullIfEmpty(payload.motherName);
  if (payload.motherOccupation !== undefined) data.motherOccupation = nullIfEmpty(payload.motherOccupation);
  if (payload.motherMobile !== undefined) data.motherMobile = nullIfEmpty(payload.motherMobile);
  if (payload.addressVillage !== undefined) data.addressVillage = nullIfEmpty(payload.addressVillage);
  if (payload.addressPostOffice !== undefined) data.addressPostOffice = nullIfEmpty(payload.addressPostOffice);
  if (payload.addressUpozila !== undefined) data.addressUpozila = payload.addressUpozila;
  if (payload.addressDistrict !== undefined) data.addressDistrict = payload.addressDistrict;
  if (payload.sscInstitute !== undefined) data.sscInstitute = payload.sscInstitute;
  if (payload.sscBoard !== undefined) data.sscBoard = nullIfEmpty(payload.sscBoard);
  if (payload.sscPassingYear !== undefined) data.sscPassingYear = nullIfEmpty(payload.sscPassingYear);
  if (payload.sscGpa !== undefined) {
    data.sscGpa =
      payload.sscGpa === null
        ? null
        : new Prisma.Decimal(payload.sscGpa);
  }

  const result = await prisma.$transaction(async (tx) => {
    if (payload.name !== undefined || payload.nickname !== undefined) {
      await tx.user.update({
        where: { id: existing.userId },
        data: {
          ...(payload.name !== undefined ? { name: payload.name } : {}),
          ...(payload.nickname !== undefined ? { nickname: payload.nickname } : {}),
        },
      });
    }
    const updated = await tx.student.update({
      where: { id },
      data,
      include: studentInclude,
    });
    await tx.activityLog.create({
      data: {
        actorId: user.userId,
        actorRole: user.role as 'SUPER_ADMIN' | 'ADMIN',
        action: 'STUDENT_UPDATED',
        entityType: 'Student',
        entityId: id,
        description: `Student "${updated.user.name}" updated`,
        metadata: { changed: Object.keys(payload) },
      },
    });
    return updated;
  });

  await clearStudentCache();
  return result;
};

const deleteStudentFromDB = async (id: string, user: JwtPayload, hard: boolean = false) => {
  const existing = await prisma.student.findUnique({ where: { id } });
  if (!existing) throw new AppError(httpStatus.NOT_FOUND, 'Student not found');

  if (hard) {
    await prisma.$transaction([
      prisma.student.delete({ where: { id } }),
      prisma.user.delete({ where: { id: existing.userId } }),
    ]);
  } else {
    await prisma.$transaction([
      prisma.student.update({
        where: { id },
        data: {
          isDeleted: true,
          deletedAt: new Date(),
          deletedBy: user.userId,
        },
      }),
      prisma.user.update({
        where: { id: existing.userId },
        data: {
          isDeleted: true,
          deletedAt: new Date(),
          deletedBy: user.userId,
        },
      }),
    ]);
  }

  await prisma.activityLog.create({
    data: {
      actorId: user.userId,
      actorRole: user.role as 'SUPER_ADMIN' | 'ADMIN',
      action: hard ? 'STUDENT_HARD_DELETED' : 'STUDENT_DELETED',
      entityType: 'Student',
      entityId: id,
      description: `Student deleted (${hard ? 'hard' : 'soft'})`,
    },
  });

  await clearStudentCache();
  return null;
};

const getMyProfileFromDB = async (userId: string) => {
  const student = await prisma.student.findUnique({
    where: { userId },
    include: {
      ...studentInclude,
      payments: {
        where: { isDeleted: false },
        orderBy: { createdAt: 'desc' },
        include: { studentCourse: { include: { course: true } } },
      },
      attendance: {
        orderBy: { date: 'desc' },
        take: 60,
      },
    },
  });
  if (!student) throw new AppError(httpStatus.NOT_FOUND, 'Student profile not found');
  return student;
};

export const StudentService = {
  admitStudentToDB,
  enrollExistingStudentToDB,
  getAllStudentsFromDB,
  getStudentByIdFromDB,
  updateStudentInDB,
  deleteStudentFromDB,
  getMyProfileFromDB,
};
