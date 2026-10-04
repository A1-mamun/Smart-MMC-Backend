import httpStatus from 'http-status';
import { Prisma } from '@prisma/client';
import { JwtPayload } from 'jsonwebtoken';
import prisma from '../../utils/prisma';
import AppError from '../../errors/AppError';
import { TEnroll } from './studentCourse.validation';
import { clearCourseCache, clearStudentCache } from '../../utils/clearCache';
import generateStudentId from '../../utils/generateStudentId';

const enrollStudentToDB = async (payload: TEnroll, user: JwtPayload) => {
  const student = await prisma.student.findUnique({ where: { id: payload.studentId } });
  if (!student) throw new AppError(httpStatus.NOT_FOUND, 'Student not found');

  const course = await prisma.course.findUnique({ where: { id: payload.courseId } });
  if (!course || course.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Course not found');
  }

  const exists = await prisma.studentCourse.findUnique({
    where: {
      studentId_courseId: {
        studentId: payload.studentId,
        courseId: payload.courseId,
      },
    },
  });
  if (exists && !exists.isDeleted) {
    throw new AppError(httpStatus.CONFLICT, 'Student already enrolled in this course');
  }

  // Generate a fresh per-enrollment Student ID using the target course's
  // hscBatch + name. Same generator used at admit time — the roll is
  // global per (hscBatch, yearDigit) prefix so two enrollments in two
  // courses with different year-digits get distinct IDs.
  const newStudentCourseId = await generateStudentId(course.hscBatch, course.name);

  // Snapshot the pre-enrollment `isFreeAccount` state so the same
  // free→paid flip that `student.service.ts` does at admit time also
  // runs here. Without this, a free-class account enrolled via this
  // lighter endpoint keeps `isFreeAccount = true` while holding an
  // active `StudentCourse`, leaking into the `/dashboard/free-students`
  // roster. Mirrors the admit path's lifecycle (see student.service.ts
  // enrollExistingStudent — same flag flip, same `freeConvertedAt`
  // stamp, same FREE_STUDENT_CONVERTED activity log entry).
  const wasFree = student.isFreeAccount;

  const result = await prisma.$transaction(async (tx) => {
    let enrollment;
    if (exists) {
      enrollment = await tx.studentCourse.update({
        where: { id: exists.id },
        data: {
          isDeleted: false,
          deletedAt: null,
          deletedBy: null,
          enrolledBy: user.userId,
          enrolledAt: new Date(),
          // Preserve any pre-existing per-enrollment ID; otherwise
          // (re-enrolling a previously un-enrolled row) stamp the
          // freshly generated one.
          studentCourseId: exists.studentCourseId ?? newStudentCourseId,
        },
        include: { course: true },
      });
    } else {
      enrollment = await tx.studentCourse.create({
        data: {
          studentId: payload.studentId,
          courseId: payload.courseId,
          enrolledBy: user.userId,
          studentCourseId: newStudentCourseId,
        },
        include: { course: true },
      });
    }

    await tx.activityLog.create({
      data: {
        actorId: user.userId,
        actorRole: user.role as 'SUPER_ADMIN' | 'ADMIN',
        action: 'STUDENT_ENROLLED',
        entityType: 'StudentCourse',
        entityId: enrollment.id,
        description: `Student enrolled in "${course.name}"`,
        metadata: {
          studentId: payload.studentId,
          courseId: payload.courseId,
          studentCourseId: enrollment.studentCourseId,
        },
      },
    });

    // Free → paid flip on the Student + User rows. Done in the same
    // transaction so a failure rolls back the enrollment too — we never
    // leave a half-paid student where the enrollment landed but the
    // flag is still `true`.
    if (wasFree) {
      const now = new Date();
      await tx.student.update({
        where: { id: student.id },
        data: { isFreeAccount: false, freeConvertedAt: now },
      });
      await tx.user.update({
        where: { id: student.userId },
        data: { isFreeAccount: false, freeConvertedAt: now },
      });
      await tx.activityLog.create({
        data: {
          actorId: user.userId,
          actorRole: user.role as 'SUPER_ADMIN' | 'ADMIN',
          action: 'FREE_STUDENT_CONVERTED',
          entityType: 'Student',
          entityId: student.id,
          description: `Free student enrolled in paid course "${course.name}" via /student-course/enroll`,
          metadata: {
            studentId: student.id,
            courseId: course.id,
            courseName: course.name,
            source: 'studentCourse.enrollStudentToDB',
          },
        },
      });
    }

    return enrollment;
  });

  // BOTH caches must be cleared: the course-cache (seat counts) AND
  // the student-cache (the /student list, which is cached at 60s and
  // is what the free-students page reads). Without clearStudentCache,
  // a freshly-converted free student lingers in the cached
  // `?isFreeAccount=true` response for up to a minute.
  await clearCourseCache();
  await clearStudentCache();
  return result;
};

const completeCourseFromDB = async (id: string, user: JwtPayload) => {
  const enrollment = await prisma.studentCourse.findUnique({ where: { id } });
  if (!enrollment || enrollment.isDeleted) {
    throw new AppError(httpStatus.NOT_FOUND, 'Enrollment not found');
  }

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.studentCourse.update({
      where: { id },
      data: {
        isCompleted: true,
        completedAt: new Date(),
      },
      include: { course: true, student: { include: { user: true } } },
    });
    await tx.activityLog.create({
      data: {
        actorId: user.userId,
        actorRole: user.role as 'SUPER_ADMIN' | 'ADMIN',
        action: 'COURSE_COMPLETED',
        entityType: 'StudentCourse',
        entityId: id,
        description: `Student "${updated.student.user.name}" completed "${updated.course.name}"`,
      },
    });
    return updated;
  });

  await clearCourseCache();
  return result;
};

const getStudentCoursesFromDB = async (studentId: string) => {
  const enrollments = await prisma.studentCourse.findMany({
    where: { studentId, isDeleted: false },
    include: {
      course: true,
      payments: {
        where: { isDeleted: false },
        orderBy: { paidAt: 'desc' },
      },
    },
    orderBy: { enrolledAt: 'desc' },
  });

  return enrollments.map((enrollment) => {
    const totalPaid = enrollment.payments.reduce(
      (sum, p) => sum + Number(p.amount),
      0,
    );
    return {
      id: enrollment.id,
      // Per-enrollment Student ID — distinct from User.studentId so a
      // student enrolled in two courses has two different IDs.
      studentCourseId: enrollment.studentCourseId,
      course: enrollment.course,
      enrolledAt: enrollment.enrolledAt,
      isCompleted: enrollment.isCompleted,
      completedAt: enrollment.completedAt,
      totalPaid,
      due: Math.max(0, Number(enrollment.course.fee) - totalPaid),
      payments: enrollment.payments,
    };
  });
};

const unenrollFromDB = async (id: string, user: JwtPayload) => {
  const enrollment = await prisma.studentCourse.findUnique({ where: { id } });
  if (!enrollment) throw new AppError(httpStatus.NOT_FOUND, 'Enrollment not found');

  await prisma.studentCourse.update({
    where: { id },
    data: {
      isDeleted: true,
      deletedAt: new Date(),
      deletedBy: user.userId,
    },
  });
  // Clear both caches — the unenroll changes the student's enrollment
  // state, which the cached /student list (free vs paid bucketing)
  // depends on, and the seat-count aggregation.
  await clearCourseCache();
  await clearStudentCache();
  return null;
};

const getAllEnrollmentsFromDB = async (
  filters: { courseId?: string; isCompleted?: boolean },
) => {
  const where: Prisma.StudentCourseWhereInput = { isDeleted: false };
  if (filters.courseId) where.courseId = filters.courseId;
  if (filters.isCompleted !== undefined) where.isCompleted = filters.isCompleted;
  return prisma.studentCourse.findMany({
    where,
    include: {
      course: true,
      student: { include: { user: true } },
    },
    orderBy: { enrolledAt: 'desc' },
  });
};

export const StudentCourseService = {
  enrollStudentToDB,
  completeCourseFromDB,
  getStudentCoursesFromDB,
  unenrollFromDB,
  getAllEnrollmentsFromDB,
};