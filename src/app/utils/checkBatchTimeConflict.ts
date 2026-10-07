import { Prisma } from '@prisma/client';
import { TCreateCourse, TUpdateCourse } from '../modules/course/course.validation';
import AppError from '../errors/AppError';
import httpStatus from 'http-status';

/**
 * Default per-batch class duration in minutes. Mirrors the
 * legacy kiosk behaviour: when `BatchDay.durationMinutes` is
 * NULL (legacy row, freshly-seeded row, or any admin who
 * left the field blank) we still need a sensible window for
 * conflict-detection purposes, and 60 minutes matches the
 * historical default documented on the `BatchDay` schema.
 *
 * We deliberately keep the constant here (not in the
 * schema) so conflict-detection is a pure function of the
 * input — no DB round-trips, no service-layer state. The
 * kiosk uses the same 60-min fallback for its countdown
 * (see student.service / attendance), so the two stay in
 * lockstep.
 */
const DEFAULT_DURATION_MINUTES = 60;

const TIME_REGEX = /^(0?[1-9]|1[0-2]):([0-5][0-9])\s?(AM|PM)$/i;

/**
 * Convert a slot time string ("3:00 AM" / "12:30 PM" / "4:30 pm")
 * to minutes-since-midnight in 24-hour clock. Returns NaN for
 * any string that doesn't match `TIME_REGEX`.
 *
 * Note on midnight / noon edge cases:
 *   - "12:00 AM" → 0 (midnight)
 *   - "12:30 AM" → 30
 *   - "12:00 PM" → 720 (noon)
 *   - "12:30 PM" → 750
 *
 * The regex itself bounds the hour to 1..12 so the "0" used
 * for midnight can't be expressed — anything the frontend
 * sends in that form must round-trip to the same conflict-
 * detection set on the DB side.
 */
const parseTimeToMinutes = (time: string): number => {
  const match = TIME_REGEX.exec(time.trim());
  if (!match) return NaN;
  // match[1] is 1..12, match[3] is AM/PM.
  let hour = Number(match[1]);
  const ampm = match[3].toUpperCase();
  const minutes = Number(match[2]);
  if (ampm === 'AM') {
    if (hour === 12) hour = 0; // 12 AM → 0
  } else {
    if (hour !== 12) hour += 12; // 1 PM → 13, etc.
  }
  return hour * 60 + minutes;
};

type SlotInterval = {
  day: string;
  start: number;
  end: number;
  courseName?: string;
  source: 'incoming' | 'existing';
};

/**
 * Build per-slot intervals from a BatchDay's day/time/duration
 * payload. Each (day, time) entry expands into a half-open
 * interval [start, end). A slot whose durationMinutes is
 * null/undefined falls back to the 60-min legacy default so
 * legacy rows still get a sensible conflict window.
 *
 * Invalid time strings (anything that doesn't match the
 * batchTimeRegex from course.validation.ts) are skipped —
 * the schema validator already rejected them when the request
 * arrived, so seeing them here means we got the data from
 * the DB (legacy rows). Skipping is safer than throwing and
 * keeps the checker usable against historic data.
 */
const expandBatchDayToSlots = (
  days: string[],
  times: string[],
  durationMinutes: number | null | undefined,
  courseName: string | undefined,
  source: 'incoming' | 'existing',
): SlotInterval[] => {
  const duration = durationMinutes ?? DEFAULT_DURATION_MINUTES;
  const out: SlotInterval[] = [];
  for (const day of days) {
    const normalizedDay = day.toLowerCase().trim();
    for (const time of times) {
      const start = parseTimeToMinutes(time);
      if (Number.isNaN(start)) continue;
      out.push({
        day: normalizedDay,
        start,
        // end is exclusive — a slot ending at exactly the
        // next slot's start minute does NOT collide. This
        // matches what admins intuitively mean when they
        // back-to-back classes.
        end: start + duration,
        courseName,
        source,
      });
    }
  }
  return out;
};

/**
 * Half-open interval intersection. Two slots collide when
 * they share a day AND their [start, end) ranges overlap
 * strictly. Back-to-back classes (slot A ends at 8:00,
 * slot B starts at 8:00) are explicitly NOT a conflict
 * because the half-open convention lets the second class
 * start at the moment the first ends.
 */
const slotsOverlap = (a: SlotInterval, b: SlotInterval): boolean => {
  if (a.day !== b.day) return false;
  return a.start < b.end && b.start < a.end;
};

const formatTime = (totalMinutes: number): string => {
  const mins = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const hour24 = Math.floor(mins / 60);
  const minute = mins % 60;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const ampm = hour24 < 12 ? 'AM' : 'PM';
  return `${hour12}:${minute.toString().padStart(2, '0')} ${ampm}`;
};

/**
 * Detect schedule conflicts in a course create / update payload.
 *
 * The original implementation only flagged duplicate (day,
 * time) strings, which silently let slots overlap when
 * (a) the admin changed a time without changing the day,
 * (b) the new time fell within an existing slot's
 *     [start, end) range, or (c) the durationMinutes of
 *     either side extended into the other.
 *
 * With `BatchDay.durationMinutes` now part of the schema
 * (kiosk countdown + conflict-aware scheduling), the
 * checker has to expand each slot into a real time
 * interval — [start, end), where end = start +
 * durationMinutes — and flag any pair of intervals that
 * share a day AND strictly overlap.
 *
 * Conflict window conventions:
 *   - Time strings are parsed with the same regex as
 *     course.validation.ts (h:mm AM/PM), so the
 *     checker's view of "3:00 AM" matches the validation
 *     layer's view — anything the form rejects the
 *     checker never sees.
 *   - A NULL durationMinutes falls back to the legacy
 *     60-min default so pre-durationMinutes seed rows
 *     still get a sensible window.
 *   - Intervals are half-open: a class ending at 8:00
 *     does NOT conflict with one starting at 8:00. This
 *     matches the admin's intuitive sense of "back-to-
 *     back" classes.
 *   - Overlap is checked both ways:
 *       1. Within the incoming payload itself (catches
 *          duplicate / overlapping entries typed into
 *          the same form submission).
 *       2. Against every existing BatchDay in the DB,
 *          excluding the course being updated
 *          (`excludeCourseId`).
 *
 * The `excludeCourseId` parameter matters for the update
 * path: when an admin edits an existing course, the DB
 * already holds the course's own current BatchDay rows,
 * and we don't want the checker to flag a slot against
 * itself. The course service passes the current course id
 * on update; create omits the parameter entirely.
 */
export const checkBatchTimeConflict = async (
  tx: Prisma.TransactionClient,
  // Accept either create (required durationMinutes) or update
  // (optional durationMinutes — legacy rows can still pass null).
  // Both shapes are structurally compatible; widening the param to
  // the looser (update) body shape lets a single function serve
  // both callers without an unsafe cast.
  batchDays: NonNullable<TUpdateCourse['body']['batchDays']>,
  excludeCourseId?: string,
) => {
  // Expand incoming BatchDays into per-slot intervals.
  const incomingSlots: SlotInterval[] = [];
  for (const batchDay of batchDays) {
    incomingSlots.push(
      ...expandBatchDayToSlots(
        batchDay.days,
        batchDay.times,
        batchDay.durationMinutes,
        undefined,
        'incoming',
      ),
    );
  }

  // Intra-payload overlap check. Walk every pair of
  // incoming slots; the first collision wins and we throw
  // with a message that tells the admin which two slots
  // collided (so they can fix it without having to guess).
  for (let i = 0; i < incomingSlots.length; i++) {
    for (let j = i + 1; j < incomingSlots.length; j++) {
      if (slotsOverlap(incomingSlots[i], incomingSlots[j])) {
        const a = incomingSlots[i];
        const b = incomingSlots[j];
        throw new AppError(
          httpStatus.CONFLICT,
          `Schedule conflict in request: ${a.day} ${formatTime(a.start)}–${formatTime(a.end)} overlaps ${b.day} ${formatTime(b.start)}–${formatTime(b.end)}.`,
        );
      }
    }
  }

  // Pull every existing BatchDay from the DB, scoped by
  // `excludeCourseId` so the update path doesn't flag the
  // course against itself. We also fetch `durationMinutes`
  // so legacy 60-min defaults and explicit per-batch
  // durations both participate in the overlap check.
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
      durationMinutes: true,
      course: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  const existingSlots: SlotInterval[] = [];
  for (const existingBatchDay of existingBatchDays) {
    existingSlots.push(
      ...expandBatchDayToSlots(
        existingBatchDay.days,
        existingBatchDay.times,
        existingBatchDay.durationMinutes,
        existingBatchDay.course.name,
        'existing',
      ),
    );
  }

  // Cross-check: every incoming slot against every existing
  // slot. First collision wins.
  for (const incoming of incomingSlots) {
    for (const existing of existingSlots) {
      if (slotsOverlap(incoming, existing)) {
        throw new AppError(
          httpStatus.CONFLICT,
          `Schedule conflict: ${incoming.day} ${formatTime(incoming.start)}–${formatTime(incoming.end)} overlaps ${existing.courseName ?? 'an existing course'}'s slot (${formatTime(existing.start)}–${formatTime(existing.end)}).`,
        );
      }
    }
  }
};