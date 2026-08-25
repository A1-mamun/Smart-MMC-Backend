import httpStatus from 'http-status';
import dayjs from 'dayjs';
import { Prisma } from '@prisma/client';
import { JwtPayload } from 'jsonwebtoken';
import prisma from '../../utils/prisma';
import AppError from '../../errors/AppError';
import { TCheckIn, TManualCheckIn, TGetStudentAttendance, TGetToday } from './attendance.validation';
import calculatePagination from '../../utils/calculatePagination';
import { clearAttendanceCache } from '../../utils/clearCache';

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

  let attendance = await prisma.attendance.findUnique({
    where: { studentId_date: { studentId: student.id, date: today } },
  });

  let isFirstCheckIn = false;
  if (!attendance) {
    attendance = await prisma.attendance.create({
      data: {
        studentId: student.id,
        date: today,
        method: 'NFC',
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
      studentId: user.studentId,
      name: user.name,
      nickname: user.nickname,
    },
    attendanceId: attendance.id,
    date: attendance.date,
    checkInAt: attendance.checkInAt,
    method: attendance.method,
    isFirstCheckIn,
    courseNames,
    dueAmount,
    message: isFirstCheckIn
      ? `Welcome, ${user.name}!`
      : `${user.name} already checked in today.`,
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
    },
  });

  if (!student) throw new AppError(httpStatus.NOT_FOUND, 'Student not found');

  const targetDate = payload.date ? dayjs(payload.date).startOf('day').toDate() : getTodayDate();

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
        metadata: { studentId: student.id, date: targetDate },
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
    checkInAt: attendance.checkInAt,
    method: attendance.method,
    isFirstCheckIn,
    courseNames: student.studentCourses.map((e) => e.course.name),
    message: isFirstCheckIn
      ? `Attendance marked for ${student.user.name}.`
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