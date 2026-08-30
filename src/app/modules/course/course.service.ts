import httpStatus from 'http-status';
import { Prisma } from '@prisma/client';
import prisma from '../../utils/prisma';
import AppError from '../../errors/AppError';
import { TCreateCourse, TUpdateCourse, TGetAllCourses, TBatchDayInput } from './course.validation';
import calculatePagination from '../../utils/calculatePagination';
import { clearCourseCache } from '../../utils/clearCache';
import { checkBatchTimeConflict } from '../../utils/checkBatchTimeConflict';

const courseInclude = {
  batchDays: {
    orderBy: { position: 'asc' as const },
  },
};

const createCourseToDB = async (payload: TCreateCourse) => {
  const exists = await prisma.course.findFirst({
    where: { name: payload.name, hscBatch: payload.hscBatch },
  });
  if (exists) {
    throw new AppError(httpStatus.CONFLICT, 'Course with this name already exists');
  }

  const course = await prisma.$transaction(async (tx) => {
    // Check schedule conflicts BEFORE creating anything
    await checkBatchTimeConflict(tx, payload.batchDays);
    const course = await tx.course.create({
      data: {
        name: payload.name,
        description: payload.description,
        fee: new Prisma.Decimal(payload.fee),
        hscBatch: payload.hscBatch,
      },
    });
    for (const [position, day] of payload.batchDays.entries()) {
      await tx.batchDay.create({
        data: {
          courseId: course.id,
          name: day.name,
          days: day.days,
          times: day.times,
          position,
        },
      });
    }
    return tx.course.findUnique({
      where: { id: course.id },
      include: courseInclude,
    });
  });

  await clearCourseCache();
  return course;
};

const getAllCoursesFromDB = async (filters: TGetAllCourses) => {
  const { page, limit, skip, sortBy, sortOrder } = calculatePagination(filters);
  const where: Prisma.CourseWhereInput = { isDeleted: false };
  if (filters.isActive !== undefined) {
    where.isActive = filters.isActive === 'true' || filters.isActive === true;
  }
  if (filters.searchTerm) {
    where.OR = [
      // { name: { contains: filters.searchTerm, mode: 'insensitive' } },
      { description: { contains: filters.searchTerm, mode: 'insensitive' } },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.course.findMany({
      where,
      skip,
      take: limit,
      orderBy: { [sortBy]: sortOrder },
      include: courseInclude,
    }),
    prisma.course.count({ where }),
  ]);

  return { data, meta: { page, limit, total } };
};

const getCourseByIdFromDB = async (id: string) => {
  const course = await prisma.course.findUnique({
    where: { id },
    include: courseInclude,
  });
  if (!course) throw new AppError(httpStatus.NOT_FOUND, 'Course not found');
  return course;
};

// const updateCourseInDB = async (id: string, payload: TUpdateCourse['body']) => {
//   const data: Prisma.CourseUpdateInput = {};
//   if (payload.name) data.name = payload.name;
//   if (payload.description !== undefined) data.description = payload.description;
//   if (payload.fee !== undefined) data.fee = new Prisma.Decimal(payload.fee);
//   if (payload.hscBatch) data.hscBatch = payload.hscBatch;
//   if (payload.isActive !== undefined) data.isActive = payload.isActive;

//   const updated = await prisma.$transaction(async (tx) => {
//     await tx.course.update({ where: { id }, data });
//     if (payload.batchDays) {
//       await tx.batchDay.deleteMany({ where: { courseId: id } });
//       for (const [position, day] of payload.batchDays.entries()) {
//         await tx.batchDay.create({
//           data: {
//             courseId: id,
//             name: day.name,
//             days: day.days,
//             times: day.times,
//             position,
//           },
//         });
//       }
//     }
//     return tx.course.findUnique({
//       where: { id },
//       include: courseInclude,
//     });
//   });

//   await clearCourseCache();
//   return updated;
// };

const updateCourseInDB = async (id: string, payload: TUpdateCourse['body']) => {
  const data: Prisma.CourseUpdateInput = {};

  if (payload.name !== undefined) {
    data.name = payload.name;
  }

  if (payload.description !== undefined) {
    data.description = payload.description;
  }

  if (payload.fee !== undefined) {
    data.fee = new Prisma.Decimal(payload.fee);
  }

  if (payload.hscBatch !== undefined) {
    data.hscBatch = payload.hscBatch;
  }

  if (payload.isActive !== undefined) {
    data.isActive = payload.isActive;
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Check whether course exists
    const existingCourse = await tx.course.findUnique({
      where: {
        id,
      },
    });

    if (!existingCourse) {
      throw new AppError(httpStatus.NOT_FOUND, 'Course not found');
    }

    /*
     * Only check schedule conflicts when batchDays
     * are actually being updated.
     */
    if (payload.batchDays) {
      await checkBatchTimeConflict(
        tx,
        payload.batchDays,
        id, // Exclude current course
      );
    }

    // Update course information
    await tx.course.update({
      where: {
        id,
      },
      data,
    });

    /*
     * Replace existing batch days
     */
    if (payload.batchDays) {
      await tx.batchDay.deleteMany({
        where: {
          courseId: id,
        },
      });

      await tx.batchDay.createMany({
        data: payload.batchDays.map((day, position) => ({
          courseId: id,
          name: day.name,
          days: day.days,
          times: day.times,
          position,
        })),
      });
    }

    return tx.course.findUnique({
      where: {
        id,
      },
      include: courseInclude,
    });
  });

  await clearCourseCache();
  return updated;
};

const toggleCourseActiveToDB = async (id: string, isActive: boolean) => {
  const existing = await prisma.course.findUnique({ where: { id } });
  if (!existing) throw new AppError(httpStatus.NOT_FOUND, 'Course not found');
  const updated = await prisma.course.update({
    where: { id },
    data: { isActive },
  });
  await clearCourseCache();
  return updated;
};

const deleteCourseFromDB = async (id: string) => {
  await prisma.course.update({
    where: { id },
    data: { isDeleted: true },
  });
  await clearCourseCache();
  return null;
};

export const CourseService = {
  createCourseToDB,
  getAllCoursesFromDB,
  getCourseByIdFromDB,
  updateCourseInDB,
  toggleCourseActiveToDB,
  deleteCourseFromDB,
};

export type { TBatchDayInput };
