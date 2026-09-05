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
     *
     * Preserve BatchDay ids (and the StudentBatch.batchDayId foreign keys
     * that point at them) by upserting in place instead of deleting the
     * whole list and recreating it:
     *
     *   - Incoming row with an `id` that matches an existing row for this
     *     course → update it (FKs stay attached).
     *   - Incoming row without an `id` → create it.
     *   - Existing rows whose `id` is NOT in the incoming list → delete
     *     them (these are rows the user removed). Any StudentBatch still
     *     pointing at one of these has its `batchDayId` set to NULL by the
     *     schema's `onDelete: SetNull` rule.
     */
    if (payload.batchDays) {
      const existingDays = await tx.batchDay.findMany({
        where: { courseId: id },
        select: { id: true, name: true },
      });
      const existingById = new Map(existingDays.map((d) => [d.id, d]));
      const existingIds = new Set(existingDays.map((d) => d.id));
      const incomingIds = new Set(
        payload.batchDays.map((d) => d.id).filter((dId): dId is string => typeof dId === 'string'),
      );

      for (const [position, day] of payload.batchDays.entries()) {
        const dayData = {
          name: day.name,
          days: day.days,
          times: day.times,
          position,
        };
        if (day.id && existingById.has(day.id)) {
          // Matched — update in place so StudentBatch.batchDayId FKs are preserved.
          await tx.batchDay.update({
            where: { id: day.id },
            data: dayData,
          });

          /*
           * Propagate the (potentially renamed) BatchDay name to every
           * StudentBatch row that points at it. StudentBatch stores the
           * name denormalized (see admission flow in student.service),
           * so a rename without this propagation would leave students'
           * batch labels stale until the next admission edit. Done in the
           * same transaction so we never half-update.
           */
          const previous = existingById.get(day.id);
          const previousName = previous?.name ?? null;
          if (previousName !== day.name) {
            await tx.studentBatch.updateMany({
              where: { batchDayId: day.id, isDeleted: false },
              data: { batchDay: day.name },
            });
          }
        } else {
          // No matching id (or id not provided) — create a new row.
          // If a stray id was sent that doesn't belong to this course, we
          // silently ignore it rather than throw, to keep the endpoint
          // forgiving for stale forms.
          await tx.batchDay.create({
            data: {
              courseId: id,
              ...dayData,
            },
          });
        }
      }

      // Delete only the rows the user actually removed. Orphaned
      // StudentBatch.batchDayId values are set to NULL via `onDelete: SetNull`.
      const orphanIds = [...existingIds].filter((dId) => !incomingIds.has(dId));
      if (orphanIds.length > 0) {
        await tx.batchDay.deleteMany({
          where: { id: { in: orphanIds } },
        });
      }
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
