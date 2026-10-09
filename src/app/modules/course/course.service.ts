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
  // TToggleAdmitAnotherCourse,
} from './course.validation';
import calculatePagination from '../../utils/calculatePagination';
import { clearCourseCache } from '../../utils/clearCache';
import { checkBatchTimeConflict } from '../../utils/checkBatchTimeConflict';

/**
 * Per-slot "barcode scan allowed right now" flag, parallel to
 * `times[]`. Strictly binary — no tri-state, no auto-cycle:
 * the admin turns a slot ON at class start and OFF at class
 * end. The kiosk treats `true` as "admit scans for this slot"
 * and `false` as "reject scans". The cross-course "only one
 * ON" invariant is enforced at write time by
 * `toggleBatchSlotToDB` (turning one slot ON auto-disables
 * every other slot in the database).
 *
 * Length must match `times[]`; the backend pads/trims to keep
 * the arrays in sync.
 */
const normaliseSlotStates = (incoming: boolean[] | undefined, timesLength: number): boolean[] =>
  normaliseBooleanArray(incoming, timesLength, false);

/**
 * Pad / trim a per-slot boolean array to match `times.length`.
 * Used by the create / update paths so the parallel arrays
 * (slotStates, manualWindowOverride, …) always stay in sync
 * with the canonical `times[]` shape. Behaviour:
 *   - Empty / undefined `incoming` → all `defaultValue` (e.g.
 *     `false` for the "off by default" fields, `true` for the
 *     "on by default" fields).
 *   - Truncated if the admin SHRUNK `times[]` (e.g. dropped a
 *     slot) — extra flags are discarded.
 *   - Padded with `defaultValue` if the admin EXTENDED
 *     `times[]` (e.g. added a slot) — new slots default to
 *     `defaultValue` so a quick edit doesn't accidentally
 *     flip a new slot to the opposite state.
 */
const normaliseBooleanArray = (
  incoming: boolean[] | undefined,
  timesLength: number,
  defaultValue: boolean,
): boolean[] => {
  const result: boolean[] = [];
  for (let i = 0; i < timesLength; i++) {
    if (incoming && i < incoming.length) {
      result.push(Boolean(incoming[i]));
    } else {
      result.push(defaultValue);
    }
  }
  return result;
};

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
        // Persist the seat cap verbatim. `totalSeats` is now
        // REQUIRED on the create schema (1..10000) so by the
        // time we reach this branch it's always a positive
        // integer. The Prisma column stays nullable for
        // backward compat with legacy rows — those were
        // written before the field was made required and
        // still render the "Uncapped" badge.
        totalSeats: payload.totalSeats,
      },
    });
    for (const [position, day] of payload.batchDays.entries()) {
      // Pad slotStates to match times.length (legacy rows + first-time
      // creates default to all-ON). Slot states are per-slot and
      // independent — admins can create a batch with multiple slots
      // all-ON. The kiosk only promotes the slot whose wall-clock
      // window is currently open, so co-ON slots don't fight each
      // other at scan time. Keeping create permissive avoids
      // rejecting a perfectly valid initial state ("all slots
      // admitting").
      const slotStates = normaliseSlotStates(day.slotStates, day.times.length);
      const manualWindowOverride = normaliseBooleanArray(
        day.manualWindowOverride,
        day.times.length,
        false,
      );
      await tx.batchDay.create({
        data: {
          courseId: course.id,
          name: day.name,
          days: day.days,
          times: day.times,
          durationMinutes: day.durationMinutes,
          slotStates,
          manualWindowOverride,
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
      .filter(
        (s): s is { batchDayId: string; batchTime: string; enrolled: number } =>
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

  // Status-aware slotStates gate: only `ONGOING` courses can have
  // a non-default slotStates array applied. For `ADMISSION` /
  // `COMPLETE` courses we strip the field from the payload — the
  // existing per-BatchDay `slotStates` in the DB is preserved (so
  // a course that transitions ONGOING → COMPLETE keeps its last
  // admitted-slot state, even though the rule itself is only
  // enforced for ONGOING courses). The `slotStates` for a
  // freshly-created ADMISSION row is the all-ON default from
  // `normaliseSlotStates`, which is the only safe value the rule
  // accepts.
  if (payload.batchDays) {
    const existing = await prisma.course.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!existing) {
      throw new AppError(httpStatus.NOT_FOUND, 'Course not found');
    }
    if (existing.status !== 'ONGOING') {
      // Strip slotStates from every batchDay before propagation so
      // the per-BatchDay `slotStates` is preserved verbatim. The
      // admin can flip the course to ONGOING first (via the status
      // segmented control), then toggle individual slots.
      payload = {
        ...payload,
        batchDays: payload.batchDays.map((d) => ({
          ...d,
          durationMinutes: d.durationMinutes,
          slotStates: undefined,
        })),
      };
    }
  }

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
        select: { id: true, name: true, times: true },
      });
      const existingById = new Map(existingDays.map((d) => [d.id, d]));
      const existingIds = new Set(existingDays.map((d) => d.id));
      const incomingIds = new Set(
        payload.batchDays.map((d) => d.id).filter((dId): dId is string => typeof dId === 'string'),
      );

      for (const [position, day] of payload.batchDays.entries()) {
        // Pad slotStates to match the (possibly edited) times[]
        // length. If the admin omitted slotStates in the form
        // payload, default to all-ON so legacy / first-time writes
        // continue to accept scans until the admin explicitly
        // toggles a slot OFF. Slot states are per-slot and
        // independent — see `toggleBatchSlotToDB` for the
        // per-slot write semantics.
        const slotStates = normaliseSlotStates(day.slotStates, day.times.length);
        const manualWindowOverride = normaliseBooleanArray(
          day.manualWindowOverride,
          day.times.length,
          // Default to false — absent values mean "use the
          // default 5-min window", the same as an explicit false.
          false,
        );
        const dayData = {
          name: day.name,
          days: day.days,
          times: day.times,
          slotStates,
          manualWindowOverride,
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

          /*
           * Propagate the `times[]` change to every StudentBatch
           * row that points at this BatchDay. StudentBatch stores
           * `batchTime` denormalized (the per-enrollment slot
           * time) so the swap-resolver, the 5-min check-in window
           * guard, and the admin's per-batch filters all see the
           * new time without a fresh admit / re-enroll round-trip.
           *
           * Critical correctness rule: each per-slot rename must
           * update ONLY the students that were in THAT slot at
           * the start of the transaction. Concretely — if the
           * admin renames `times[0] = "3:00 AM"` → `"3:30 AM"`,
           * the 2 students enrolled in the 3:00 AM slot must
           * follow their slot to 3:30 AM, while the 2 students
           * in the 4:00 AM slot must stay at 4:00 AM. We must
           * NOT clobber the 4:00 AM students into 3:30 AM as
           * well.
           *
           * Naive per-row updateMany ({ where: { batchTime: oldTime } })
           * is wrong for two reasons:
           *
           *   1. SWAP / COLLISION: if the admin reorders times
           *      so that an old value reappears at a different
           *      index, step N's `where batchTime: oldTime` will
           *      also match rows that an earlier step just moved
           *      into that value. Example — `["3:00 AM", "4:00 AM"]`
           *      → `["4:00 AM", "3:30 AM"]`:
           *        step 0: UPDATE WHERE batchTime="3:00 AM" → "4:00 AM"
           *          → 2 students now at "4:00 AM"
           *        step 1: UPDATE WHERE batchTime="4:00 AM" → "3:30 AM"
           *          → matches the 2 ORIGINAL "4:00 AM" students
           *            PLUS the 2 just-moved "3:00 AM" students.
           *            All 4 end up at "3:30 AM". Wrong.
           *
           *   2. ORPHAN SWEEP over-reach: the prior code followed
           *      the per-slot pass with a `where batchTime NOT IN
           *      newTimes` sweep that reassigned every "drifted"
           *      row to `newTimes[0]`. The intent was to catch
           *      legacy seed rows whose batchTime was no longer
           *      in the catalog, but in practice it also pulled
           *      in rows that had been moved by the per-slot
           *      pass to a new value that happened to also be a
           *      target — producing cascading rewrites.
           *
           * Fix: snapshot the per-slot membership of
           * StudentBatch at the START of the per-slot loop
           * (captured before any UPDATE runs), then drive the
           * per-slot UPDATEs by StudentBatch.id rather than by
           * the mutable `batchTime` column. This is collision-
           * safe regardless of how the new times[] is ordered
           * relative to the old.
           */
          const previousTimes = previous?.times ?? [];
          const newTimes = day.times;

          if (previousTimes.length > 0 && newTimes.length > 0) {
            // Snapshot: which StudentBatch rows were in each old slot?
            // We capture { id, batchTime } so we can rewrite by id
            // below — ids are stable for the lifetime of the
            // transaction, whereas `batchTime` is the column we're
            // mutating.
            const snapshot = await tx.studentBatch.findMany({
              where: { batchDayId: day.id, isDeleted: false },
              select: { id: true, batchTime: true },
            });

            // Bucket snapshot rows by their original `batchTime`.
            // Rows with a `batchTime` that doesn't match any
            // previous slot (legacy drift from earlier seeds) go
            // into the `null` bucket for the orphan pass.
            const byOldTime = new Map<string, string[]>();
            for (const row of snapshot) {
              const list = byOldTime.get(row.batchTime) ?? [];
              list.push(row.id);
              byOldTime.set(row.batchTime, list);
            }

            // Track every value we've decided a StudentBatch row
            // can end up with during this transaction — the
            // union of the new times[] and any of the
            // previously-existing times that we're about to map
            // onto a new value. The orphan pass below only
            // rewrites rows whose `batchTime` is in NEITHER
            // set, so we don't accidentally re-clobber rows we
            // just intentionally moved.
            const assignedTimes = new Set<string>(newTimes);

            // Per-slot rename: walk the OLD times[] positions
            // and, for each, rewrite the students that started
            // in that slot to the corresponding new time. Use
            // the snapshot's ids so we're immune to mid-loop
            // mutations.
            //
            // Two cases for `newTime`:
            //   - Admin kept slot i (newTimes[i] is defined and
            //     differs from previousTimes[i]): rename in
            //     place, e.g. "3:00 AM" → "3:30 AM".
            //   - Admin DROPPED slot i (newTimes[i] is undefined
            //     because the new array is shorter): the students
            //     that were in the dropped slot need a
            //     re-home. We pick `newTimes[0]` (the surviving
            //     first slot) so the enrollment doesn't go
            //     dangling — the admin can re-edit to a specific
            //     slot later. This is a best-effort safety net
            //     for explicit slot removal.
            for (let slotIdx = 0; slotIdx < previousTimes.length; slotIdx++) {
              const oldTime = previousTimes[slotIdx];
              const ids = byOldTime.get(oldTime) ?? [];
              if (ids.length === 0) continue;
              const newTime = slotIdx < newTimes.length ? newTimes[slotIdx] : newTimes[0];
              if (oldTime === newTime) continue;
              // Use a chunked write only because updateMany's
              // `data` shape is a single value, not per-row —
              // every id in the bucket shares the same target
              // time so a single updateMany is correct.
              await tx.studentBatch.updateMany({
                where: { id: { in: ids }, isDeleted: false },
                data: { batchTime: newTime },
              });
              // Add the target time to the "live" set so the
              // orphan pass below doesn't treat a freshly-
              // assigned value as drift. (Note: the OLD time
              // is what we want the orphan pass to recognise
              // as already-handled — and that's implicit
              // because we already processed its bucket in
              // this loop iteration. The orphan pass only
              // sees `byOldTime` keys that AREN'T in
              // `assignedTimes`; since `assignedTimes`
              // already contained the new times at start-up,
              // the only way a key can be in the orphan set
              // is if its rows were already handled above OR
              // were genuinely stale from before this
              // transaction.)
              assignedTimes.add(newTime);
            }

            // Orphan pass: any StudentBatch whose ORIGINAL
            // batchTime is neither a value the admin kept
            // (in newTimes) nor a value we just deliberately
            // mapped somewhere. This is the safety net for
            // legacy seed rows whose batchTime drifted from
            // BatchDay.times[] long ago (e.g. an earlier
            // schema migration that didn't propagate). We
            // re-home them to newTimes[0] so the enrollment
            // doesn't go dangling.
            //
            // We deliberately do NOT include rows whose only
            // "drift" is that they're about to be (or just
            // were) rewritten by the per-slot pass. Those rows
            // are already accounted for above.
            const orphanTimes: string[] = [];
            for (const oldTime of byOldTime.keys()) {
              if (!assignedTimes.has(oldTime)) orphanTimes.push(oldTime);
            }
            if (orphanTimes.length > 0) {
              // Re-read any rows whose batchTime is in the
              // orphan set AND wasn't rewritten by the
              // per-slot pass above (which used the snapshot
              // ids, so the only way a row is still at an
              // orphan time is if it was orphaned before
              // this transaction even started).
              await tx.studentBatch.updateMany({
                where: {
                  batchDayId: day.id,
                  batchTime: { in: orphanTimes },
                  isDeleted: false,
                },
                data: { batchTime: newTimes[0] },
              });
            }
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
const setCourseStatusToDB = async (id: string, payload: TSetStatus['body'], user: JwtPayload) => {
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

/**
 * Flip a single slot's `slotEnabled` flag.
 *
 * Slots are fully independent — toggling a slot ON or OFF only
 * mutates the target slot's `slotStates[i]`. Sibling slots across
 * the same course (and across other courses) are untouched, so
 * multiple slots can be ON at the same time. The admin manually
 * manages each slot's admit state; this endpoint is the
 * per-slot write that powers the Courses page switch.
 *
 * The kiosk / current-batch endpoint already only surfaces a
 * "current" slot when it falls inside the wall-clock window of
 * an ON slot — with the per-slot state independent, the kiosk
 * will simply pick the one that's currently running. Cross-slot
 * coordination is no longer the server's job.
 *
 * Status gate: only `ONGOING` courses can have slot states
 * toggled. An ADMISSION course hasn't started yet and a
 * COMPLETE course has already graduated, so neither has a need
 * for a live-admit slot. Reject toggles on non-ONGOING courses
 * with a 400 so the Courses page UI can hide the switch
 * entirely.
 */
const toggleBatchSlotToDB = async (
  courseId: string,
  payload: {
    batchDayId: string;
    slotIndex: number;
    enabled: boolean;
  },
  user: JwtPayload,
) => {
  const course = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course) throw new AppError(httpStatus.NOT_FOUND, 'Course not found');
  if (course.status !== 'ONGOING') {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Slot toggling is only allowed on ONGOING courses. This course is currently ${course.status}. Move it to ONGOING first via the status segmented control.`,
    );
  }

  const batchDay = await prisma.batchDay.findUnique({
    where: { id: payload.batchDayId },
    select: { id: true, courseId: true, times: true, slotStates: true },
  });
  if (!batchDay || batchDay.courseId !== courseId) {
    throw new AppError(httpStatus.NOT_FOUND, 'BatchDay not found in this course');
  }
  if (payload.slotIndex < 0 || payload.slotIndex >= batchDay.times.length) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `slotIndex ${payload.slotIndex} is out of range (BatchDay has ${batchDay.times.length} slots)`,
    );
  }

  // Per-slot toggle — only the target slot's flag flips, siblings
  // untouched. We pad the array to `times.length` so the new flag
  // lands on the correct index even for legacy rows with a short
  // array, then write the full padded array back to keep the
  // parallel-to-`times[]` invariant.
  const padded = normaliseSlotStates(batchDay.slotStates, batchDay.times.length);
  padded[payload.slotIndex] = payload.enabled;

  const updated = await prisma.batchDay.update({
    where: { id: batchDay.id },
    data: { slotStates: padded },
    include: { course: { select: { id: true, name: true } } },
  });

  await prisma.activityLog.create({
    data: {
      actorId: user.userId,
      actorRole: user.role as 'SUPER_ADMIN' | 'ADMIN',
      action: 'BATCH_SLOT_TOGGLED',
      entityType: 'BatchDay',
      entityId: updated.id,
      description: `${updated.course.name} · ${updated.name} slot ${payload.slotIndex + 1} (${updated.times[payload.slotIndex]}) ${payload.enabled ? 'ENABLED' : 'DISABLED'}`,
      metadata: {
        courseId: updated.courseId,
        batchDayId: updated.id,
        slotIndex: payload.slotIndex,
        enabled: payload.enabled,
      },
    },
  });

  await clearCourseCache();
  return updated;
};

/**
 * Toggle the per-slot "check-in window override" flag. The
 * default check-in window opens at class start and closes 5
 * minutes after; this override lets the admin open the window
 * early (e.g. admit a parent who's early) or keep it open
 * past the 5-min mark (e.g. when the class is delayed).
 *
 * Cross-slot invariant: only ONE override can be open across
 * the entire database at any time. Opening the override on
 * slot X auto-closes every other slot's override (across all
 * courses), so the kiosk can never serve two override-open
 * slots concurrently. The cascade applies whenever the
 * override is being opened (`open: true`) — closing an
 * override is a per-slot no-op on siblings.
 *
 * Pre-condition: the override can only be opened if the
 * target slot's `slotStates[i]` is `true`. The override is a
 * "skip the 5-min wall-clock guard" switch — it only makes
 * sense on a slot that's already admitting scans. Opening the
 * override on an OFF slot is rejected with a 400 so the admin
 * doesn't accidentally create a window that the `slotStates`
 * guard will then reject. The override endpoint NEVER writes
 * `slotStates[]` — the two flags are independent and managed
 * by separate toggles.
 *
 * Status gate: same as `toggleBatchSlotToDB` — only `ONGOING`
 * courses can have their slots overridden.
 */
const setSlotWindowOverrideToDB = async (
  courseId: string,
  payload: {
    batchDayId: string;
    slotIndex: number;
    open: boolean;
  },
  user: JwtPayload,
) => {
  const course = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course) throw new AppError(httpStatus.NOT_FOUND, 'Course not found');
  if (course.status !== 'ONGOING') {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Slot window override is only available on ONGOING courses. This course is currently ${course.status}.`,
    );
  }

  const batchDay = await prisma.batchDay.findUnique({
    where: { id: payload.batchDayId },
    select: {
      id: true,
      courseId: true,
      manualWindowOverride: true,
      slotStates: true,
      times: true,
    },
  });
  if (!batchDay || batchDay.courseId !== courseId) {
    throw new AppError(httpStatus.NOT_FOUND, 'BatchDay not found in this course');
  }
  if (payload.slotIndex < 0 || payload.slotIndex >= batchDay.times.length) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `slotIndex ${payload.slotIndex} is out of range (BatchDay has ${batchDay.times.length} slots)`,
    );
  }

  // Pre-condition: the override can only be opened on a slot
  // whose `slotStates[i]` is `true`. The override is the "skip
  // the wall-clock guard" switch — it only makes sense on a
  // slot that's already admitting scans. If the admin is
  // trying to open an override on an OFF slot, reject with
  // 400 so they don't accidentally create a window that the
  // admit guard will then reject.
  if (payload.open) {
    const paddedStates = normaliseSlotStates(batchDay.slotStates, batchDay.times.length);
    if (paddedStates[payload.slotIndex] !== true) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Cannot open the window override on a slot that isn't admitting. Turn the slot ON first.",
      );
    }
  }

  /*
   * Cross-slot cascade: when `open: true`, flip every other
   * slot's `manualWindowOverride` to `false` so only the
   * target slot's override is open across the whole database.
   * We pull every BatchDay in a single round-trip (the table
   * is small) and write back the full padded array per row to
   * keep the parallel-to-`times[]` invariant. The target row
   * gets its own override flipped to `true`.
   *
   * When `open: false`, only the target slot's override flips
   * to `false` — closing an override is a per-slot no-op on
   * siblings (mirrors the slot-state toggle's close semantics).
   */
  const allBatchDays = await prisma.batchDay.findMany({
    select: {
      id: true,
      times: true,
      manualWindowOverride: true,
    },
  });

  const updates: Array<{ id: string; manualWindowOverride: boolean[] }> = [];
  for (const bd of allBatchDays) {
    const padded = normaliseBooleanArray(
      bd.manualWindowOverride,
      bd.times.length,
      false,
    );
    if (payload.open) {
      for (let i = 0; i < padded.length; i++) {
        if (bd.id === batchDay.id && i === payload.slotIndex) {
          padded[i] = true;
        } else {
          padded[i] = false;
        }
      }
    } else {
      if (bd.id === batchDay.id) {
        padded[payload.slotIndex] = false;
      }
    }
    updates.push({ id: bd.id, manualWindowOverride: padded });
  }

  // Apply all updates in a single transaction so the global
  // invariant ("exactly one override open at a time") either
  // holds across every row or rolls back together. Individual
  // updates are independent; the $transaction wrapper is what
  // makes "all rows update or none" possible.
  await prisma.$transaction(
    updates.map((u) =>
      prisma.batchDay.update({
        where: { id: u.id },
        data: { manualWindowOverride: u.manualWindowOverride },
      }),
    ),
  );

  // Re-read the target row so the response carries the
  // post-update manualWindowOverride array (used by the toast
  // / UI to confirm the override landed).
  const updated = await prisma.batchDay.findUnique({
    where: { id: batchDay.id },
    include: { course: { select: { id: true, name: true } } },
  });
  if (!updated) {
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      'BatchDay vanished mid-override',
    );
  }

  await prisma.activityLog.create({
    data: {
      actorId: user.userId,
      actorRole: user.role as 'SUPER_ADMIN' | 'ADMIN',
      action: 'BATCH_SLOT_WINDOW_OVERRIDE_TOGGLED',
      entityType: 'BatchDay',
      entityId: updated.id,
      description: `${updated.course.name} · ${updated.name} slot ${payload.slotIndex + 1} (${updated.times[payload.slotIndex]}) window ${payload.open ? 'OPEN' : 'CLOSED'}`,
      metadata: {
        courseId: updated.courseId,
        batchDayId: updated.id,
        slotIndex: payload.slotIndex,
        open: payload.open,
      },
    },
  });

  await clearCourseCache();
  return updated;
};

export const CourseService = {
  createCourseToDB,
  getAllCoursesFromDB,
  getCourseByIdFromDB,
  getCourseSeatsFromDB,
  updateCourseInDB,
  toggleCourseAdmitAnotherCourseToDB,
  setCourseStatusToDB,
  toggleBatchSlotToDB,
  setSlotWindowOverrideToDB,
  deleteCourseFromDB,
};

export type { TBatchDayInput };
