import httpStatus from 'http-status';
import bcrypt from 'bcrypt';
import { Prisma } from '@prisma/client';
import prisma from '../../utils/prisma';
import AppError from '../../errors/AppError';
import config from '../../config';
import generateStudentId from '../../utils/generateStudentId';
import generateInitialPassword from '../../utils/generatePassword';
import { TAdmitStudent, TUpdateStudent, TGetAllStudents } from './student.validation';
import calculatePagination from '../../utils/calculatePagination';
import { clearStudentCache } from '../../utils/clearCache';
import { JwtPayload } from 'jsonwebtoken';

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
    include: {
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

const admitStudentToDB = async (payload: TAdmitStudent, user: JwtPayload) => {
  const existingByMobile = await prisma.student.findFirst({
    where: { mobile: payload.mobile, isDeleted: false },
  });
  if (existingByMobile) {
    throw new AppError(httpStatus.CONFLICT, 'A student with this mobile number already exists');
  }

  const course = await prisma.course.findUnique({
    where: { id: payload.courseId },
    include: { batchDays: { orderBy: { position: 'asc' } } },
  });
  if (!course || course.isDeleted) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Selected course not found');
  }
  if (!course.isActive) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Selected course is not active');
  }

  const matchingBatchDay = course.batchDays.find((d) => d.id === payload.batchDayId);
  if (!matchingBatchDay) {
    throw new AppError(httpStatus.BAD_REQUEST, `Selected batch day does not belong to this course`);
  }
  if (!matchingBatchDay.times.includes(payload.batchTime)) {
    throw new AppError(httpStatus.BAD_REQUEST, `Selected time is not offered for this batch day`);
  }

  const studentId = await generateStudentId(course.hscBatch, course.name);
  const initialPassword = generateInitialPassword(10);
  const hashedPassword = await bcrypt.hash(initialPassword, Number(config.bcryptSaltRounds) || 12);

  const student = await prisma.$transaction(async (tx) => {
    const newUser = await tx.user.create({
      data: {
        studentId,
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
        bloodGroup: payload.bloodGroup,
        fatherName: payload.fatherName,
        fatherOccupation: payload.fatherOccupation,
        fatherMobile: payload.fatherMobile,
        motherName: payload.motherName,
        motherOccupation: payload.motherOccupation,
        motherMobile: payload.motherMobile,
        addressVillage: payload.addressVillage,
        addressPostOffice: payload.addressPostOffice,
        addressUpozila: payload.addressUpozila,
        addressDistrict: payload.addressDistrict,
        sscInstitute: payload.sscInstitute,
        sscBoard: payload.sscBoard,
        sscPassingYear: payload.sscPassingYear,
        sscGpa: new Prisma.Decimal(payload.sscGpa),
        admittedBy: user.userId,
      },
    });

    await tx.studentCourse.create({
      data: {
        studentId: newStudent.id,
        courseId: course.id,
        enrolledBy: user.userId,
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
  };
};

const getAllStudentsFromDB = async (
  filters: TGetAllStudents,
  options: { page?: number; limit?: number; sortBy?: string; sortOrder?: 'asc' | 'desc' },
) => {
  const { page, limit, skip, sortBy, sortOrder } = calculatePagination(options);
  const { searchTerm, hscBatch, courseId, batchDay, batchDayId, batchTime, district, ...rest } =
    filters;

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
    const batchWhere: Prisma.StudentBatchWhereInput = { isDeleted: false };
    if (batchDay) batchWhere.batchDay = batchDay;
    if (batchTime) batchWhere.batchTime = batchTime;
    andConditions.push({ batches: { some: batchWhere } });
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
  // values. A student with no active enrollments is PENDING. If every active
  // enrollment is PAID, the student is PAID. If any is PARTIAL and none is
  // PAID, the student is PARTIAL. Otherwise PENDING.
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
    const hasActive = enrollments.length > 0;
    const status: 'PENDING' | 'PARTIAL' | 'PAID' = !hasActive
      ? 'PENDING'
      : totalFee <= 0
      ? 'PENDING'
      : totalPaid >= totalFee
      ? 'PAID'
      : totalPaid > 0
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

  // Derive paymentStatus from the persisted StudentCourse.status values.
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
  const hasActive = enrollments.length > 0;
  const status: 'PENDING' | 'PARTIAL' | 'PAID' = !hasActive
    ? 'PENDING'
    : totalFee <= 0
    ? 'PENDING'
    : totalPaid >= totalFee
    ? 'PAID'
    : totalPaid > 0
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
  if (payload.motherName !== undefined) data.motherName = payload.motherName;
  if (payload.motherOccupation !== undefined) data.motherOccupation = payload.motherOccupation;
  if (payload.motherMobile !== undefined) data.motherMobile = payload.motherMobile;
  if (payload.addressVillage !== undefined) data.addressVillage = payload.addressVillage;
  if (payload.addressPostOffice !== undefined) data.addressPostOffice = payload.addressPostOffice;
  if (payload.addressUpozila !== undefined) data.addressUpozila = payload.addressUpozila;
  if (payload.addressDistrict !== undefined) data.addressDistrict = payload.addressDistrict;
  if (payload.sscInstitute !== undefined) data.sscInstitute = payload.sscInstitute;
  if (payload.sscBoard !== undefined) data.sscBoard = payload.sscBoard;
  if (payload.sscPassingYear !== undefined) data.sscPassingYear = payload.sscPassingYear;
  if (payload.sscGpa !== undefined) data.sscGpa = new Prisma.Decimal(payload.sscGpa);

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
  getAllStudentsFromDB,
  getStudentByIdFromDB,
  updateStudentInDB,
  deleteStudentFromDB,
  getMyProfileFromDB,
};
