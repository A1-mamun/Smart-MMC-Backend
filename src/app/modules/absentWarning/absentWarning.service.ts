import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import AppError from '../../errors/AppError';
import httpStatus from 'http-status';
import { StudentService } from '../student/student.service';
import { toIntl } from '../../utils/phone';
// NOTE: When re-enabling the disabled auto-send block below, also
// add `import { instituteLocalDate } from '../../utils/classDayCalendar';`
// — the disabled code path uses it to anchor ISO date strings to the
// BD calendar for safe @db.Date round-trips.

// Extend tz-aware plugins for the `today` / `targetDate` helpers
// below. classDayCalendar.ts also extends these, but absentWarning is
// imported in isolation paths where classDayCalendar may not have
// been loaded yet.
dayjs.extend(utc);
dayjs.extend(timezone);

// The imports below are only used by the auto-send logic that is
// temporarily disabled (see comment block at runAbsentWarningJobFromDB
// and runForTargets). They are kept commented here so re-enabling the
// auto-SMS path is a one-step uncomment operation. The next re-enable
// should also restore the `dayjs.extend(isoWeek)` call below.
/*
import isoWeek from 'dayjs/plugin/isoWeek';
import { JwtPayload } from 'jsonwebtoken';
import prisma from '../../utils/prisma';
import { SmsService } from '../sms/sms.service';
dayjs.extend(isoWeek);
*/

type TJobResult = {
  /** Total recipients the gateway accepted. */
  sent: number;
  /** Recipients the gateway rejected or that had no valid mobile. */
  skipped: number;
  /** Cohort size after attendance + weekly dedupe subtraction. */
  total: number;
  /** The ISO dates the job considered — useful for diagnostics. */
  datesProcessed: string[];
};

/**
 * Hardcoded SMS body. The user explicitly removed the Settings UI for
 * absent-warning (mode/schedule/template) — the job is now always-on,
 * always "today only", always father-only. The message is fixed so
 * there is nothing for the UI to misconfigure.
 *
 * Currently unused because the auto-send code is disabled (see
 * runForTargets). Kept here so re-enabling the auto path is one
 * uncomment away.
 */
const ABSENT_WARNING_MESSAGE =
  'Dear parent, your ward {studentName} was absent from class today ({classDate}). Please ensure regular attendance.';
// Reference the constant so lint is happy while the auto-send code is
// disabled. Remove this no-op when re-enabling.
void ABSENT_WARNING_MESSAGE;

/**
 * Build the recipient list for a single target date WITHOUT sending.
 * Used by the SMS panel's "Absent on date" filter (the admin reviews
 * the list, types a message, then clicks Send through the regular
 * /api/v1/sms endpoint — so the picker doesn't need to do the send).
 *
 * Per spec: father's mobile ONLY. No mother / self fallback. Students
 * without a usable father-mobile are reported in `skipped` so the
 * admin can see why a row didn't make the cut.
 */
const getAbsentPickerFromDB = async (params: { date: string }) => {
  // Both `targetDate` and `today` are anchored to Asia/Dhaka so they
  // line up with the @db.Date column values the attendance service
  // writes (which are also BD-anchored via the institute TZ helper).
  // Without this, a UTC server can mis-classify the "is this a future
  // date?" guard by up to a day around the BD midnight boundary.
  const targetDate = dayjs.utc(params.date).tz('Asia/Dhaka').startOf('day').toDate();
  const today = dayjs().tz('Asia/Dhaka').startOf('day').toDate();
  if (targetDate.getTime() > today.getTime()) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Cannot query absentees for a future date',
    );
  }

  // Reuse the existing cohort resolver — `absentOnDate` is part of
  // the getAllStudentsFromDB filter chain (subtracts Attendance rows
  // for the date automatically).
  //
  // `isFreeAccount: undefined` so the cohort includes both paid and
  // free-class students — the absent-warning picker is an
  // operations view, not a marketer view, and we want to remind
  // students regardless of their enrollment category.
  const cohort = await StudentService.getAllStudentsFromDB(
    { absentOnDate: targetDate, isFreeAccount: undefined, limit: 1000, page: 1 },
    { page: 1, limit: 1000 },
  );

  const recipients: {
    studentId: string;
    name: string;
    mobile: string;
  }[] = [];
  const skipped: { studentId: string; name: string; reason: string }[] = [];

  for (const s of cohort.data) {
    const fatherIntl = s.fatherMobile ? toIntl(s.fatherMobile) : null;
    if (fatherIntl) {
      recipients.push({
        studentId: s.id,
        name: s.user.name,
        mobile: fatherIntl,
      });
    } else {
      skipped.push({
        studentId: s.id,
        name: s.user.name,
        reason: 'No valid father mobile',
      });
    }
  }

  return {
    recipients,
    skipped,
    summary: {
      cohortSize: cohort.data.length,
      recipientCount: recipients.length,
      skippedCount: skipped.length,
      date: dayjs(targetDate).format('YYYY-MM-DD'),
    },
  };
};

/**
 * Run the absent-warning job end-to-end. Called by:
 *   1. The cron scheduler (daily tick), with `actorId='SYSTEM'`
 *      and `actorRole='SYSTEM'`.
 *   2. The settings page "Run now" button — same call but with the
 *      signed-in admin as actor. (Note: the Settings page no longer
 *      exposes this button by default; the route still exists as an
 *      admin escape hatch for manual back-fills.)
 *
 * The job targets students who had a class TODAY but have no
 * Attendance row for today — i.e. real-time same-day absence. The
 * idempotency is enforced by `WeeklyAbsentWarning`: a row per
 * (studentId, isoYear, isoWeek) blocks re-warns for the rest of the
 * week, matching the user's "max one time in a week" rule.
 *
 * SMS is sent to the father's mobile only. There is no mother / self
 * fallback. Students with no usable father-mobile are tracked as
 * `skipped` so the operator can see WHY a row didn't deliver.
 */
// ============================================================================
// DISABLED: Automatic SMS sending is temporarily turned off per user request
// (2026-10-01). The code below is intact and ready to re-enable — see the
// matching block in `runForTargets` further down and the cron tick in
// `settings/scheduler.ts`. Routes/controllers stay so manual admin triggers
// (curl/Postman) still hit a working endpoint that returns a clean no-op.
// ============================================================================
/*
const runAbsentWarningJobFromDB = async (
  actorId: string,
  actorRole: 'SUPER_ADMIN' | 'ADMIN' | 'SYSTEM',
): Promise<TJobResult> => {
  // Today only — the spec is "students who had class today but did
  // not attend". We still pass through `runForTargets` so the dedupe
  // + chunked-send code path is reused.
  const today = dayjs().format('YYYY-MM-DD');
  return runForTargets([today], actorId, actorRole);
};
*/

// Live no-op stub. Keeps the export + signature stable so the controller
// route (`POST /api/v1/settings/absent-warning/run`) keeps compiling and
// returns a clean "0 sent" response when an admin fires it manually.
const runAbsentWarningJobFromDB = async (
  _actorId: string,
  _actorRole: 'SUPER_ADMIN' | 'ADMIN' | 'SYSTEM',
): Promise<TJobResult> => {
  void _actorId;
  void _actorRole;
  return {
    sent: 0,
    skipped: 0,
    total: 0,
    datesProcessed: [],
  };
};

/**
 * Lower-level entry point the cron scheduler uses to inject its
 * pre-computed target dates. Exported because the absent-warning
 * route can call it directly with a user-supplied date for one-off
 * back-fills.
 *
 * Per spec: father's mobile only, hardcoded message. The signature
 * stays target-date-array based so a manual back-fill can pass a
 * non-today date without re-implementing dedupe / chunking.
 */
const runForTargets = async (
  targetDates: string[],
  _actorId: string,
  _actorRole: 'SUPER_ADMIN' | 'ADMIN' | 'SYSTEM',
): Promise<TJobResult> => {
  // ============================================================================
  // DISABLED: Automatic SMS sending is temporarily turned off per user request
  // (2026-10-01). The original implementation is preserved in the comment
  // block below for easy re-enable. Routes/controllers stay so manual admin
  // triggers (curl/Postman) still hit a working endpoint that returns a
  // clean no-op.
  // ============================================================================
  void _actorId;
  void _actorRole;
  return {
    sent: 0,
    skipped: 0,
    total: 0,
    datesProcessed: targetDates,
  };
  /*
  // Per-ISO-week dedupe set.
  const isoYearNow = dayjs().isoWeekYear();
  const isoWeekNow = dayjs().isoWeek();
  const alreadyWarnedRows = await prisma.weeklyAbsentWarning.findMany({
    where: { isoYear: isoYearNow, isoWeek: isoWeekNow },
    select: { studentId: true },
  });
  const alreadyWarned = new Set(alreadyWarnedRows.map((r) => r.studentId));

  // For each target date, pull the cohort (expected minus present).
  // We dedupe by studentId across dates — if a student was absent on
  // both Sunday and Monday in the back-fill window, we only warn
  // them once (matches "one warning per week"), using the most-recent
  // absent-date in the substituted message.
  const perStudentAbsents = new Map<
    string,
    { name: string; mobile: string; absentDate: Date }
  >();
  const skippedNoFatherMobile: string[] = [];

  for (const isoDate of targetDates) {
    // `isoDate` arrives as a YYYY-MM-DD string that the caller
    // (auto-send scheduler or manual picker) has already anchored to
    // BD. Re-shape to a UTC-midnight Date whose UTC date parts equal
    // that BD-local day so the value we pass to Prisma's @db.Date
    // column and to the cohort resolver's `absentOnDate` filter both
    // round-trip correctly across server TZs.
    const d = instituteLocalDate(new Date(`${isoDate}T00:00:00Z`));
    const cohort = await StudentService.getAllStudentsFromDB(
      { absentOnDate: d, limit: 1000, page: 1 },
      { page: 1, limit: 1000 },
    );
    for (const s of cohort.data) {
      if (alreadyWarned.has(s.id)) continue;
      if (perStudentAbsents.has(s.id)) continue; // earliest wins
      // Father-only by spec — no mother / self fallback.
      const fatherIntl = s.fatherMobile ? toIntl(s.fatherMobile) : null;
      if (!fatherIntl) {
        skippedNoFatherMobile.push(s.id);
        continue;
      }
      perStudentAbsents.set(s.id, {
        name: s.user.name,
        mobile: fatherIntl,
        absentDate: d,
      });
    }
  }

  const recipients = Array.from(perStudentAbsents.entries()).map(
    ([studentId, v]) => ({
      studentId,
      name: v.name,
      mobile: v.mobile,
      absentDate: v.absentDate,
    }),
  );

  if (recipients.length === 0) {
    return {
      sent: 0,
      skipped: skippedNoFatherMobile.length,
      total: 0,
      datesProcessed: targetDates,
    };
  }

  // Send in chunks of 500 (the existing sendSmsSchema max). For the
  // first iteration the gateway log gets ONE entry per chunk; the
  // dedupe rows are written in a single createMany afterwards so the
  // per-row `smsLogId` points to the chunk that actually delivered
  // them.
  let sent = 0;
  let skipped = 0;
  const CHUNK_SIZE = 500;
  for (let i = 0; i < recipients.length; i += CHUNK_SIZE) {
    const chunk = recipients.slice(i, i + CHUNK_SIZE);
    // The gateway log stores a SINGLE message body — pick the most
    // common absent-date in the chunk for the per-chunk log row.
    // Per-recipient substitution happens client-side via the
    // template; the gateway just sees one body per chunk.
    const dates = chunk.map((c) => dayjs(c.absentDate).format('YYYY-MM-DD'));
    const primaryDate = dates[0];
    const sampleName = chunk[0].name;
    const body = ABSENT_WARNING_MESSAGE.replaceAll(
      '{studentName}',
      sampleName,
    ).replaceAll('{classDate}', primaryDate);

    const result = await SmsService.sendSmsToDB(
      {
        mode: 'ONE_TO_MANY',
        recipients: chunk.map((c) => ({
          studentId: c.studentId,
          name: c.name,
          mobile: c.mobile,
        })),
        message: body,
      },
      // SYSTEM actor is the cron; ADMIN/SUPER_ADMIN is the human
      // pressing the button. Cast is safe — SmsService only reads
      // `userId` and `role`.
      { userId: actorId, role: actorRole } as JwtPayload,
    );
    sent += result.log.count;
    skipped += result.skipped.length;

    await prisma.weeklyAbsentWarning.createMany({
      data: chunk.map((c) => ({
        studentId: c.studentId,
        isoYear: isoYearNow,
        isoWeek: isoWeekNow,
        absentDate: c.absentDate,
        sentToMobile: c.mobile,
        smsLogId: result.log.id,
      })),
      skipDuplicates: true,
    });
  }

  return {
    sent,
    skipped: skipped + skippedNoFatherMobile.length,
    total: recipients.length + skippedNoFatherMobile.length,
    datesProcessed: targetDates,
  };
  */
};

export const AbsentWarningService = {
  getAbsentPickerFromDB,
  runAbsentWarningJobFromDB,
  // exposed for the scheduler + manual back-fill route
  runForTargets,
};
