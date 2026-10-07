import dayjs from 'dayjs';

/**
 * Parse an "h:mm AM/PM" string (the format `BatchDay.times[]` and
 * `StudentBatch.batchTime` are stored in) into a total
 * minutes-since-midnight number. Returns `null` on malformed input
 * so the caller can skip rather than crash on a typo'd schedule.
 *
 * Centralised here (rather than duplicated in `attendance.service.ts`
 * as `parseTimeOfDay`) because both the current-batch feature and
 * the 5-min scan-window guard depend on the same parse — keeping
 * one definition ensures they always agree on edge cases like
 * midnight-spanning times.
 */
export const parseTimeOfDay = (raw: string): number | null => {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const meridiem = m[3].toUpperCase();
  if (meridiem === 'PM' && hour !== 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
};

/**
 * Calendar-class-day helpers. Used by `attendance.service.ts` to resolve
 * a barcode/NFC scan on a peer-batch day into an attendance row stamped
 * for the student's dedicated class day.
 *
 * The rule (per the absent-warning discussion + the user's spec):
 *   A student enrolled in Batch A = [Sat, Mon, Wed] with the course's
 *   union of class days = [Sun, Mon, Tue, Wed, Thu, Sat] (Batch B =
 *   [Sun, Tue, Thu] shares no days with Batch A) can make up a missed
 *   class by attending the previous OR next class day in the union, but
 *   never skip a day. So:
 *     - Sunday scan → record for Saturday (prev-in-union, dedicated).
 *     - Tuesday scan → record for Monday (prev-in-union, dedicated).
 *     - Thursday scan → record for Wednesday (prev-in-union, dedicated).
 *     - Saturday scan when student is in Batch B → record for Sunday
 *       (next-in-union, dedicated).
 *     - Friday scan → reject ("no class scheduled in your course today").
 *     - Saturday scan when student is in Batch A → normal (no swap).
 *     - Monday/Wednesday scan for Batch A student → normal (no swap).
 *
 * Same algorithm captures both the "missed class → make up the next
 * union day" direction AND the "emergency on dedicated day → attended
 * the previous union day" direction because both are just "scan day is
 * adjacent to a dedicated day in the cyclic union".
 */

export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export type TWeekdayName = (typeof WEEKDAY_NAMES)[number];

// Lower-cased lookup set so we can do case-insensitive membership
// tests without re-iterating the canonical array. `new Set` of a
// readonly literal array widens to `Set<string>` automatically; the
// explicit annotation here is defensive in case TS narrows it back
// to the literal union type (which would break `.has(lower)` for
// mixed-case input).
const WEEKDAY_SET_LOWER: ReadonlySet<string> = new Set(
  WEEKDAY_NAMES.map((w) => w.toLowerCase()),
);

/**
 * Inverse of `weekdayNameFor` in `student.service.ts`. Returns 0..6 for
 * the canonical English name; accepts lowercase / mixed case. Throws on
 * unknown values so callers fail loud rather than silently treating
 * typos as Friday (=6).
 */
export const weekdayIndexFor = (name: string): number => {
  const idx = WEEKDAY_NAMES.findIndex(
    (w) => w.toLowerCase() === name.trim().toLowerCase(),
  );
  if (idx === -1) {
    throw new Error(`Invalid weekday name: ${JSON.stringify(name)}`);
  }
  return idx;
};

/**
 * Convert a Date to the canonical English weekday name used in
 * `BatchDay.days[]` rows. Centralised here so we don't duplicate the
 * array literal across modules.
 */
export const weekdayNameFor = (d: Date): TWeekdayName => {
  const name = WEEKDAY_NAMES[d.getDay()];
  // The lookup is bounds-safe — getDay() always returns 0..6 — but TS
  // doesn't know that. The cast keeps callers' types tight.
  return name as TWeekdayName;
};

/**
 * Normalise a `BatchDay.days[]` array (free-form user input preserved
 * case-insensitively) to a deduped set of canonical weekday names.
 * Unknown values are dropped silently — the UI may have leftover
 * legacy rows with typo'd day names; the attendance swap just ignores
 * them and treats the rest.
 */
const normaliseDays = (days: string[] | null | undefined): TWeekdayName[] => {
  if (!days || days.length === 0) return [];
  const result: TWeekdayName[] = [];
  for (const d of days) {
    const lower = d.trim().toLowerCase();
    if (!WEEKDAY_SET_LOWER.has(lower)) continue;
    const canonical = WEEKDAY_NAMES.find((w) => w.toLowerCase() === lower);
    if (canonical && !result.includes(canonical)) result.push(canonical);
  }
  return result;
};

/**
 * A single BatchDay row's payload, as fetched by the attendance
 * service. We accept the loose shape (just `days: string[]`) so the
 * helper doesn't have to know about Prisma's generated types.
 */
export type TClassDayBatchDay = {
  id: string;
  days: string[];
};

/**
 * Compute the cyclic union of all `BatchDay.days[]` rows in a course,
 * sorted by Sunday-first weekday index. e.g. Batch A = [Sat,Mon,Wed]
 * + Batch B = [Sun,Tue,Thu] → ['Sun','Mon','Tue','Wed','Thu','Sat']
 * (Friday is skipped because neither batch runs on Friday).
 */
export const buildCourseClassDayUnion = (
  batchDays: TClassDayBatchDay[],
): TWeekdayName[] => {
  const seen = new Set<TWeekdayName>();
  for (const b of batchDays) {
    for (const day of normaliseDays(b.days)) seen.add(day);
  }
  return Array.from(seen).sort((a, b) => weekdayIndexFor(a) - weekdayIndexFor(b));
};

/**
 * A single StudentBatch row with its related BatchDay (so we can read
 * `days`). The denormalised `batchDay` field on StudentBatch (e.g.
 * "SAT") is for the legacy enum-style filter on `getToday`; the swap
 * rule needs the *full* days[] array so we ignore it here.
 */
export type TClassDayStudentBatch = {
  batchDayId: string | null;
  // Legacy single-day field — unused by the resolver but kept here so
  // the call-site type stays compatible with the existing Prisma
  // include shape.
  batchDay?: string;
  // Wall-clock start time of this student's enrollment slot (e.g.
  // "4:00 PM"). Single string per `StudentBatch` row — a student
  // has exactly one batch slot per course. Used by the resolver
  // to populate `startsAtMinutes` so callers can enforce
  // time-windowed rules (e.g. the kiosk's "scan only allowed for
  // the first 5 minutes of the class" gate).
  batchTime?: string;
  batchDayRel: TClassDayBatchDay | null;
};

/**
 * Returns the canonical "dedicated" days for a student — the days in
 * their OWN BatchDay row. A student enrolled in one BatchDay row has
 * exactly those days; a student enrolled in multiple rows in the same
 * course (rare — would be two enrollments in the same course) unions
 * them.
 */
export const buildDedicatedClassDays = (
  studentBatches: TClassDayStudentBatch[],
): TWeekdayName[] => {
  const seen = new Set<TWeekdayName>();
  for (const sb of studentBatches) {
    if (!sb.batchDayRel) continue;
    for (const day of normaliseDays(sb.batchDayRel.days)) seen.add(day);
  }
  return Array.from(seen);
};

/**
 * Output of `resolveAttendanceDate`. Tagged union so callers must
 * handle every variant explicitly.
 *
 *   normal           — scan day is one of the student's dedicated
 *                      days; record for scan day, no swap.
 *   swap             — scan day is in the course union but not in the
 *                      student's dedicated set; exactly one neighbor in
 *                      the cyclic union IS dedicated; record for the
 *                      dedicated day, stamp `swapFromDate = scan day`.
 *   no_class_today   — scan day is not in the union at all (e.g. Friday
 *                      when both batches skip Friday).
 *   not_eligible     — scan day is in the union but neither neighbor is
 *                      dedicated. The student is trying to swap across
 *                      more than one class day, which the user
 *                      explicitly disallowed.
 *   no_peer_batch    — student has only one active BatchDay row in
 *                      this course; no swap is possible.
 *
 * The `startsAtMinutes` field (when set) carries the wall-clock start
 * minute-of-day of the resolved class. Callers use it to enforce
 * time-windowed rules like the kiosk's "scan only allowed for the
 * first 5 minutes of the class" gate. It's only meaningful on the
 * `normal` / `swap` variants — the rejection variants don't pick a
 * batch to validate against.
 */
export type TSwapResolution =
  | { kind: 'normal'; date: Date; startsAtMinutes: number }
  | { kind: 'swap'; date: Date; swapFromDate: Date; startsAtMinutes: number }
  | { kind: 'no_class_today' }
  | { kind: 'not_eligible' }
  | { kind: 'no_peer_batch' };

/**
 * Build the `startsAtMinutes` from the student's own batch rows for
 * the resolved weekday. Returns `null` if the student isn't enrolled
 * in a slot that runs on that weekday OR if their `batchTime` is
 * malformed (so the 5-min check-in window guard can treat the scan
 * as ambiguous and skip the guard rather than reject on bad data).
 *
 * Picked by the resolver, not by the consumer, so the contract for
 * the `startsAtMinutes` field is consistent across all callers.
 */
const pickStudentSlotStart = (
  studentBatches: TClassDayStudentBatch[],
  weekday: TWeekdayName,
): number | null => {
  for (const sb of studentBatches) {
    const bd = sb.batchDayRel;
    if (!bd || !sb.batchTime) continue;
    if (!bd.days.some((d) => d.toLowerCase() === weekday.toLowerCase())) continue;
    const parsed = parseTimeOfDay(sb.batchTime);
    if (parsed !== null) return parsed;
  }
  return null;
};

/**
 * Try to resolve a scan date to the date the attendance row should be
 * stamped with. See TSwapResolution for the outcomes.
 *
 * `studentBatches` — the student's own active StudentBatch rows for
 * this course. Drives the "dedicated" set (which days this student is
 * normally expected to attend).
 *
 * `courseBatchDays` — every BatchDay row attached to this course,
 * regardless of whether the student is enrolled in it. Drives the
 * "union" set (every day the course runs any class). Needed because a
 * student's own batches only cover their own batch — to detect the
 * peer-batch swap, the helper needs to see all batches in the course.
 */
export const resolveAttendanceDate = (params: {
  scanDate: Date;
  studentBatches: TClassDayStudentBatch[];
  courseBatchDays: TClassDayBatchDay[];
}): TSwapResolution => {
  const { scanDate, studentBatches, courseBatchDays } = params;

  // Drop soft-deleted or unlinked student-batch rows up front. A
  // StudentBatch with no batchDayRel means the BatchDay was deleted;
  // treat it as inactive.
  const active = studentBatches.filter(
    (sb) => sb.batchDayRel !== null && sb.batchDayRel !== undefined,
  );
  if (active.length === 0) {
    return { kind: 'no_peer_batch' };
  }

  // Single-batch course: no peer batch exists, so no swap can resolve.
  // Per the user's chosen behaviour, we reject the scan with a helpful
  // message rather than silently falling back to a normal check-in.
  if (courseBatchDays.length <= 1) {
    return { kind: 'no_peer_batch' };
  }

  // Build the union (across the entire course) + the dedicated set
  // (just this student's own batch days). When the course has multiple
  // batches, the dedicated set is a strict subset of the union.
  const union = buildCourseClassDayUnion(courseBatchDays);
  const dedicated = buildDedicatedClassDays(active);
  if (union.length === 0) {
    return { kind: 'no_class_today' };
  }

  const scanWeekday = weekdayNameFor(scanDate);
  const unionIdx = union.indexOf(scanWeekday);
  if (unionIdx === -1) {
    return { kind: 'no_class_today' };
  }

  // Scan day is on the dedicated set — normal check-in.
  if (dedicated.includes(scanWeekday)) {
    // `active` (filtered) is the student's own batch rows for this
    // course. Pick the first row whose `batchDayRel.days[]` contains
    // the scan weekday — that's the slot the student is enrolled in.
    // A student in multiple batches within the same course is rare;
    // we take the first match. `batchTime` is the single string
    // start-of-class for that slot.
    //
    // When the student has no parseable slot (e.g. legacy row with
    // a malformed `batchTime`), default to 0 (midnight) so the
    // check-in window guard naturally rejects the scan — the
    // alternative would be to throw, which would crash the
    // check-in flow on a single bad row.
    const slotStart = pickStudentSlotStart(active, scanWeekday) ?? 0;
    return {
      kind: 'normal',
      date: dayjs(scanDate).startOf('day').toDate(),
      startsAtMinutes: slotStart,
    };
  }

  // Walk ±1 in the cyclic union and check whether either neighbour is
  // a dedicated day. Only one of the two cases can apply at a time
  // (a student belongs to one batch, and a dedicated day uniquely
  // identifies that batch), but we handle the edge case where both
  // neighbours happen to be dedicated (impossible with the current
  // data shape but defensive).
  const prev = union[(unionIdx - 1 + union.length) % union.length];
  const next = union[(unionIdx + 1) % union.length];
  const prevDedicated = dedicated.includes(prev);
  const nextDedicated = dedicated.includes(next);

  if (prevDedicated && !nextDedicated) {
    // "Missed my dedicated day, came the next union day" — the day
    // before the scan day is the student's dedicated day. Walk back
    // 1 calendar day. dayjs handles month/year boundaries cleanly.
    // The dedicated day for the swap is `prev`, so use that to pick
    // the slot start.
    const slotStart = pickStudentSlotStart(active, prev) ?? 0;
    return {
      kind: 'swap',
      date: dayjs(scanDate).subtract(1, 'day').startOf('day').toDate(),
      swapFromDate: dayjs(scanDate).startOf('day').toDate(),
      startsAtMinutes: slotStart,
    };
  }
  if (!prevDedicated && nextDedicated) {
    // "Emergency on my dedicated day, came the previous union day" —
    // the day after the scan day is the student's dedicated day. Walk
    // forward 1 calendar day. dayjs handles week/month boundaries.
    const slotStart = pickStudentSlotStart(active, next) ?? 0;
    return {
      kind: 'swap',
      date: dayjs(scanDate).add(1, 'day').startOf('day').toDate(),
      swapFromDate: dayjs(scanDate).startOf('day').toDate(),
      startsAtMinutes: slotStart,
    };
  }
  if (prevDedicated && nextDedicated) {
    // Both neighbours dedicated — rare; pick the previous-day case and
    // let the UI / activity log flag the ambiguity. We don't have this
    // case in the seeded data; it's here so the helper is robust if
    // someone defines a batch layout that triggers it.
    const slotStart = pickStudentSlotStart(active, prev) ?? 0;
    return {
      kind: 'swap',
      date: dayjs(scanDate).subtract(1, 'day').startOf('day').toDate(),
      swapFromDate: dayjs(scanDate).startOf('day').toDate(),
      startsAtMinutes: slotStart,
    };
  }

  // Scan day is in the union but neither neighbour is dedicated — the
  // student is trying to skip a class day. Reject.
  return { kind: 'not_eligible' };
};
