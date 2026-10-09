import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

// The institute's calendar timezone. All attendance-date decisions
// (what counts as "today", which weekday a scan falls on, etc.) are
// anchored here. Pinning a single timezone rather than relying on
// the SERVER's TZ env keeps behavior stable across local dev
// machines (usually UTC), Linux containers (often UTC), and the
// institute's actual wall clock (Asia/Dhaka).
//
// Centralised here so every helper in this module reads from the
// same source of truth. Extend the dayjs instance with utc + timezone
// once at module load — these are no-ops if already extended, and
// dayjs.extend is idempotent per plugin.
dayjs.extend(utc);
dayjs.extend(timezone);
const INSTITUTE_TZ = 'Asia/Dhaka';

/**
 * "Today" as a JS Date representing midnight at the start of the
 * institute's current calendar day. The returned Date's UTC instant
 * is whatever `1970-01-01T00:00:00 in Asia/Dhaka` happens to be — the
 * important property is that `.getDay()`, `dayjs(t).format('ddd')`,
 * and any other day-of-week / date formatting yield the institute's
 * local weekday, NOT the server's local weekday.
 *
 * Use this everywhere a "what date is it right now from the
 * institute's perspective" decision is made — checking today's
 * attendance, picking a cron tick's date, etc.
 *
 * Callers that just need the weekday name should use
 * `weekdayNameForInstituteToday()` instead, which avoids the Date
 * round trip entirely.
 */
export const getInstituteToday = (): Date => dayjs().tz(INSTITUTE_TZ).startOf('day').toDate();

/**
 * The weekday name for "today" from the institute's perspective.
 * Equivalent to `weekdayNameFor(getInstituteToday())` but skips the
 * intermediate Date so there's no chance of accidentally using a
 * server-local Date somewhere downstream.
 */
export const weekdayNameForInstituteToday = (): TWeekdayName => {
  const name = WEEKDAY_NAMES[dayjs().tz(INSTITUTE_TZ).day()];
  return name as TWeekdayName;
};

/**
 * Like `instituteDateOnly` but reads the weekday in the institute's
 * timezone. Use this for any day-of-week decision that should be
 * anchored to BD local time rather than the server's local TZ.
 */
export const weekdayNameForInstitute = (d: Date): TWeekdayName => {
  const name = WEEKDAY_NAMES[dayjs.utc(d).tz(INSTITUTE_TZ).day()];
  return name as TWeekdayName;
};

/**
 * Build the JS Date that should be handed to Prisma when writing into a
 * `@db.Date` column (e.g. `Attendance.date`, `Exam.examDate`, etc.).
 *
 * Why a separate helper from `dayjs(d).startOf('day').toDate()`?
 *   Postgres `@db.Date` has no time component and no TZ of its own —
 *   the date it stores is whatever the JS Date's UTC date components
 *   happen to be, because Prisma's PG driver serialises the JS Date
 *   by extracting its UTC year/month/day. So if we want the column
 *   to read as `2026-10-08`, we MUST pass Prisma a JS Date whose UTC
 *   date parts are `2026-10-08`.
 *
 * The returned Date is always a UTC-midnight Date whose UTC date
 * parts equal the BD-local YYYY-MM-DD. On read, Prisma hydrates a
 * `@db.Date` column to `T00:00:00.000Z` in UTC, which is exactly the
 * shape we return here — so reads round-trip cleanly.
 *
 * Use this for any value being written to or compared against a
 * `@db.Date` column.
 */
export const instituteLocalDate = (d: Date): Date => {
  const bd = dayjs.utc(d).tz(INSTITUTE_TZ);
  return new Date(Date.UTC(bd.year(), bd.month(), bd.date()));
};

/**
 * Build the BD-local YYYY-MM-DD string for an arbitrary Date. Useful
 * for error messages, activity log descriptions, and other places
 * where a printable date string is preferred over a Date object.
 */
export const instituteLocalDateString = (d: Date): string =>
  dayjs.utc(d).tz(INSTITUTE_TZ).format('YYYY-MM-DD');

/**
 * Parse an "h:mm AM/PM" string (the format `BatchDay.times[]` and
 * `StudentBatch.batchTime` are stored in) into a total
 * minutes-since-midnight number. Returns `null` on malformed input
 * so the caller can skip rather than crash on a typo'd schedule.
 *
 * Centralised here because both the current-batch feature and the
 * 5-min scan-window guard depend on the same parse — keeping one
 * definition ensures they always agree on edge cases like
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
 * Calendar-class-day helpers. Used by `attendance.service.ts` to
 * decide whether a barcode / NFC scan happened on a day the student
 * is enrolled in.
 *
 * Make-up attendance is no longer supported — students can only attend
 * their own enrolled slot. The resolver below therefore has only two
 * outcomes:
 *   - `normal`         — today IS in the student's dedicated day set;
 *                        record the row for today.
 *   - `no_class_today` — today is NOT in the student's dedicated set;
 *                        reject the scan.
 *
 * If we ever re-introduce make-up classes, the resolver would need to
 * grow again — for now the simple binary rule keeps the kiosk + manual
 * check-in paths trivial.
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
const WEEKDAY_SET_LOWER: ReadonlySet<string> = new Set(WEEKDAY_NAMES.map((w) => w.toLowerCase()));

/**
 * Inverse of `weekdayNameFor` in `student.service.ts`. Returns 0..6 for
 * the canonical English name; accepts lowercase / mixed case. Throws on
 * unknown values so callers fail loud rather than silently treating
 * typos as Friday (=6).
 */
export const weekdayIndexFor = (name: string): number => {
  const idx = WEEKDAY_NAMES.findIndex((w) => w.toLowerCase() === name.trim().toLowerCase());
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
 * legacy rows with typo'd day names; the resolver just ignores them
 * and treats the rest.
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
 * A single StudentBatch row with its related BatchDay (so we can read
 * `days`). The denormalised `batchDay` field on StudentBatch (e.g.
 * "SAT") is for the legacy enum-style filter on `getToday`; the
 * resolver needs the *full* days[] array so we ignore it here.
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
 * Compute the "dedicated" days for a student — the days in their
 * OWN BatchDay row (a student enrolled in multiple rows in the same
 * course unions them).
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
 * Outcome of `resolveTodayAgainstStudentBatches`. Tagged union so
 * callers must handle every variant explicitly.
 *
 *   normal           — today IS one of the student's dedicated
 *                      class days; record for today.
 *                      `startsAtMinutes` carries the wall-clock start
 *                      of the matched slot so the caller can enforce
 *                      time-windowed rules like the kiosk's
 *                      "scan only allowed for the first 5 minutes
 *                      of the class" gate.
 *   no_class_today   — today is NOT one of the student's dedicated
 *                      class days (the student tried to scan on a
 *                      day they aren't enrolled in). Caller should
 *                      reject with a 400.
 *   no_enrollment    — the student has no active enrollment (no
 *                      StudentBatch rows attached to a live
 *                      BatchDay). Caller should reject with a 400.
 */
export type TTodayResolution =
  | { kind: 'normal'; startsAtMinutes: number }
  | { kind: 'no_class_today' }
  | { kind: 'no_enrollment' };

/**
 * Find the first StudentBatch row whose BatchDay `days[]` includes
 * `weekday` and whose `batchTime` parses cleanly. Returns `null` if
 * no such row exists or the batchTime is unparseable. When no
 * parseable slot is found, the caller can default to 0 (midnight) so
 * the 5-min check-in window guard naturally rejects the scan — the
 * alternative would be to throw, which would crash the check-in flow
 * on a single bad row.
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
 * Decide whether a scan happening RIGHT NOW should be accepted as a
 * normal check-in, and (if so) what the wall-clock start of the
 * student's enrolled slot is.
 *
 * Make-up attendance is no longer supported — students can only attend
 * their own enrolled slot. A scan on a day the student isn't enrolled
 * in is rejected with `{ kind: 'no_class_today' }` so the caller can
 * surface a helpful 400 ("No class scheduled for your batch today").
 *
 * `studentBatches` — the student's active StudentBatch rows. Drives
 * the "dedicated" set (which days this student is normally expected
 * to attend).
 */
export const resolveTodayAgainstStudentBatches = (
  studentBatches: TClassDayStudentBatch[],
): TTodayResolution => {
  // Drop soft-deleted or unlinked student-batch rows up front. A
  // StudentBatch with no batchDayRel means the BatchDay was deleted;
  // treat it as inactive.
  const active = studentBatches.filter(
    (sb) => sb.batchDayRel !== null && sb.batchDayRel !== undefined,
  );
  if (active.length === 0) {
    return { kind: 'no_enrollment' };
  }

  const dedicated = buildDedicatedClassDays(active);
  if (dedicated.length === 0) {
    return { kind: 'no_enrollment' };
  }

  const todayWeekday = weekdayNameForInstituteToday();
  if (!dedicated.includes(todayWeekday)) {
    return { kind: 'no_class_today' };
  }

  // Today IS in the dedicated set — find the slot's start minute.
  // Default to 0 (midnight) so the check-in window guard naturally
  // rejects the scan rather than crashing on a single malformed
  // batchTime row.
  const slotStart = pickStudentSlotStart(active, todayWeekday) ?? 0;
  return { kind: 'normal', startsAtMinutes: slotStart };
};