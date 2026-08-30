import { Prisma } from '@prisma/client';
import { TCreateCourse } from '../modules/course/course.validation';
import AppError from '../errors/AppError';
import httpStatus from 'http-status';

export const checkBatchTimeConflict = async (
  tx: Prisma.TransactionClient,
  batchDays: TCreateCourse['batchDays'],
  excludeCourseId?: string,
) => {
  const requestedSlots = new Set<string>();

  // Check duplicate day + time within the new payload itself
  for (const batchDay of batchDays) {
    for (const day of batchDay.days) {
      for (const time of batchDay.times) {
        const key = `${day.toLowerCase().trim()}__${time.toLowerCase().trim()}`;

        if (requestedSlots.has(key)) {
          throw new AppError(httpStatus.CONFLICT, `Duplicate schedule: ${day} at ${time}`);
        }

        requestedSlots.add(key);
      }
    }
  }

  // Get existing batch schedules
  const existingBatchDays = await tx.batchDay.findMany({
    where: excludeCourseId
      ? {
          courseId: {
            not: excludeCourseId,
          },
        }
      : undefined,

    select: {
      days: true,
      times: true,
      course: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  // Compare requested schedules with existing schedules
  for (const existingBatchDay of existingBatchDays) {
    for (const existingDay of existingBatchDay.days) {
      for (const existingTime of existingBatchDay.times) {
        const key = `${existingDay.toLowerCase().trim()}__${existingTime.toLowerCase().trim()}`;

        if (requestedSlots.has(key)) {
          throw new AppError(
            httpStatus.CONFLICT,
            `Schedule conflict: ${existingDay} at ${existingTime} is already assigned to ${existingBatchDay.course.name}.`,
          );
        }
      }
    }
  }
};
