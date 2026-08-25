import httpStatus from 'http-status';
import { Prisma } from '@prisma/client';
import { JwtPayload } from 'jsonwebtoken';
import prisma from '../../utils/prisma';
import AppError from '../../errors/AppError';
import { TEnroll } from './studentCourse.validation';
import { clearCourseCache } from '../../utils/clearCache';

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
        },
        include: { course: true },
      });
    } else {
      enrollment = await tx.studentCourse.create({
        data: {
          studentId: payload.studentId,
          courseId: payload.courseId,
          enrolledBy: user.userId,
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
        metadata: { studentId: payload.studentId, courseId: payload.courseId },
      },
    });

    return enrollment;
  });

  await clearCourseCache();
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
  await clearCourseCache();
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