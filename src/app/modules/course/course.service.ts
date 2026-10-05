import httpStatus from 'http-status';
import { Prisma } from '@prisma/client';
import { JwtPayload } from 'jsonwebtoken';
import prisma from '../../utils/prisma';
import AppError from '../../errors/AppError';
import {
  TCreateCourse,
  TUpdateCourse,
  TGetAllCourses,
  TBatchDayInput,
  TSetStatus,
  TToggleAdmitAnotherCourse,
} from './course.validation';
import calculatePagination from '../../utils/calculatePagination';
import { clearCourseCache } from '../../utils/clearCache';
import { checkBatchTimeConflict } from '../../utils/checkBatchTimeConflict';

const courseInclude = {
  batchDays: {
    orderBy: { position: 'asc' as const },
  },
  // Aggregate enrolled-student counts so the frontend can render a
  // live "X / Y seats taken" badge without a second round-trip. Counts
  // include soft-deleted StudentCourse rows; the backend's transaction-
  // locked count inside `resolveBatchDayForCourse` is the source of
  // truth for actual admission.
  _count: {
    select: { studentCourses: true },
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
        // Persist the cap verbatim when supplied; let the Prisma
        // `@default(120)` take over when the field is missing. The
        // "explicit null = uncapped" path means we only persist
        // `null` when the client intentionally sent null.
        totalSeats: payload.totalSeats === undefined ? undefined : payload.totalSeats,
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
  // Course-level status filter (replaces the boolean `isCompleted`
  // filter). Tri-state enum narrows the list to one lifecycle stage.
  if (filters.status !== undefined) {
    where.status = filters.status;
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

/**
 * Per-slot seat-cap read-out for a course.
 *
 * `Course.totalSeats` is interpreted as "seats per (batchDay, batchTime)
 * slot" — see resolveBatchDayForCourse for the authoritative gate. This
 * endpoint returns the live `studentBatch` count per slot so the
 * frontend picker can disable full slots without a second transaction.
 *
 * `groupBy` runs against the new `(batchDayId, batchTime)` compound
 * index, scoped by `batchDayRel.courseId` so foreign / deleted
 * BatchDay rows never contaminate the count. Slots that have never
 * been used simply don't appear in the response — the frontend
 * renders them with `enrolled = 0` via the Map.get fallback.
 */
const getCourseSeatsFromDB = async (courseId: string) => {
  const course = await prisma.course.findUnique({
    where: { id: courseId, isDeleted: false },
    select: { id: true, totalSeats: true },
  });
  if (!course) {
    throw new AppError(httpStatus.NOT_FOUND, 'Course not found');
  }

  const rows = await prisma.studentBatch.groupBy({
    by: ['batchDayId', 'batchTime'],
    where: {
      isDeleted: false,
      student: { isDeleted: false },
      // BatchDay itself doesn't carry `isDeleted` — soft-delete lives
      // only on the relations to it. We filter by `courseId` instead,
      // which scopes the join to the right course. (Foreign / hard-
      // deleted BatchDay rows with mismatched courseId never make it
      // into the join.)
      batchDayRel: { courseId },
    },
    _count: { _all: true },
  });

  return {
    totalSeats: course.totalSeats,
    slots: rows
      .map((r) => ({
        // batchDayId can technically be null on StudentBatch (legacy
        // rows whose BatchDay was hard-deleted, leaving the FK as
        // NULL). We filter those out by skipping rows whose
        // batchDayId is null — they can't be matched to a slot in the
        // picker anyway.
        batchDayId: r.batchDayId as string | null,
        batchTime: r.batchTime,
        enrolled: r._count._all ?? 0,
      }))
      .filter((s): s is { batchDayId: string; batchTime: string; enrolled: number } =>
        s.batchDayId != null,
      ),
  };
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

  if (payload.totalSeats !== undefined) {
    // `null` is meaningful here — "uncapped". The Prisma update accepts
    // null to clear the field; `undefined` (key absent) means don't touch.
    data.totalSeats = payload.totalSeats;
  }

  if (payload.isActive !== undefined) {
    data.isActive = payload.isActive;
  }

  if (payload.status !== undefined) {
    // Same side-effect semantics as the dedicated setStatus endpoint:
    // COMPLETE stamps completedAt + flips isAllowAdmitAnotherCourse on;
    // anything else clears completedAt and flips the gate off. We don't
    // have a `user` in scope on the generic update path, so we don't
    // stamp completedBy here — the dedicated endpoint does that.
    data.status = payload.status;
    if (payload.status === 'COMPLETE') {
      data.completedAt = new Date();
      data.isAllowAdmitAnotherCourse = true;
    } else {
      data.completedAt = null;
      data.isAllowAdmitAnotherCourse = false;
    }
  }

  if (payload.isAllowAdmitAnotherCourse !== undefined) {
    // Admin explicitly overrode the gate without changing status. We
    // accept whatever they set; the next setStatus transition will
    // re-sync the two fields back to the standard mapping.
    data.isAllowAdmitAnotherCourse = payload.isAllowAdmitAnotherCourse;
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

/**
 * Independent override for the `isAllowAdmitAnotherCourse` enrollment
 * gate. Decouples the gate from `status` so an admin can:
 *
 *   - Open a still-`ADMISSION` course's gate mid-stream (e.g. a
 *     straggler student being admitted to the next batch before
 *     this batch has formally graduated).
 *   - Close the gate on a manually-flagged course without moving
 *     `status` back to `ADMISSION` (e.g. briefly opened for a one-
 *     off re-admission; the admin wants to close it without losing
 *     the COMPLETE audit trail).
 *
 * The override is short-term. The single-click setStatus transition
 * re-applies the standard mapping (COMPLETE → flag on; anything else
 * → flag off), so a later status change will reset this manual
 * override. Document this in the UI tooltip so admins aren't
 * surprised.
 */
const toggleCourseAdmitAnotherCourseToDB = async (
  id: string,
  isAllowAdmitAnotherCourse: boolean,
) => {
  const existing = await prisma.course.findUnique({ where: { id } });
  if (!existing) throw new AppError(httpStatus.NOT_FOUND, 'Course not found');
  const updated = await prisma.course.update({
    where: { id },
    data: { isAllowAdmitAnotherCourse },
    include: courseInclude,
  });
  await clearCourseCache();
  return updated;
};

/**
 * Single-click course status transition. Drives the segmented control
 * on the Courses page (ADMISSION / ONGOING / COMPLETE) and keeps
 * `isAllowAdmitAnotherCourse` consistent with the new status so the
 * descriptive badge and the actual enrollment gate can't drift:
 *
 *   - COMPLETE → flag ON (existing students may admit into another
 *     course) + completedAt + completedBy stamped for audit.
 *   - ADMISSION / ONGOING → flag OFF (existing one-course-at-a-time
 *     gate back in force) + completedAt cleared.
 *
 * Mirrors `PATCH /:id/toggle-active` so the lifecycle event has a
 * single auditable hook (and the actor `user` is in scope). Stamps
 * `completedBy` only on the COMPLETE transition.
 */
const setCourseStatusToDB = async (
  id: string,
  payload: TSetStatus['body'],
  user: JwtPayload,
) => {
  const existing = await prisma.course.findUnique({ where: { id } });
  if (!existing) throw new AppError(httpStatus.NOT_FOUND, 'Course not found');

  const status = payload.status;
  const isCompleting = status === 'COMPLETE';
  const updated = await prisma.course.update({
    where: { id },
    data: {
      status,
      isAllowAdmitAnotherCourse: isCompleting,
      completedAt: isCompleting ? new Date() : null,
      // Only stamp the actor on the COMPLETE transition. Clearing on
      // a non-COMPLETE transition is intentional — the audit trail
      // should reflect "this is NOT currently considered complete".
      completedBy: isCompleting ? user.userId : null,
    },
    include: courseInclude,
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
  getCourseSeatsFromDB,
  updateCourseInDB,
  toggleCourseActiveToDB,
  toggleCourseAdmitAnotherCourseToDB,
  setCourseStatusToDB,
  deleteCourseFromDB,
};

export type { TBatchDayInput };
