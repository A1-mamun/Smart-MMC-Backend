import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import { JwtPayload } from 'jsonwebtoken';
import prisma from '../../utils/prisma';
import AppError from '../../errors/AppError';
import httpStatus from 'http-status';
import { StudentService } from '../student/student.service';
import { SmsService } from '../sms/sms.service';
import { toIntl } from '../../utils/phone';
import { SettingsService } from '../settings/settings.service';
import { TAbsentWarningConfig } from '../settings/settings.validation';

// dayjs iso-week plugins for the per-week dedupe key.
dayjs.extend(isoWeek);

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
 * Build the recipient list for a single target date WITHOUT sending.
 * Used by the SMS panel's "Absent on date" filter (the admin reviews
 * the list, types a message, then clicks Send through the regular
 * /api/v1/sms endpoint — so the picker doesn't need to do the send).
 *
 * Returns both the recipient-shaped array (with father-mobile fallback
 * already applied and `toIntl()` normalised) AND a `skipped` array
 * for students with no valid mobile on any channel.
 */
const getAbsentPickerFromDB = async (params: { date: string }) => {
  const targetDate = dayjs(params.date).startOf('day').toDate();
  const today = dayjs().startOf('day').toDate();
  if (targetDate.getTime() > today.getTime()) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Cannot query absentees for a future date',
    );
  }

  // Reuse the existing cohort resolver — `absentOnDate` is now part of
  // the getAllStudentsFromDB filter chain (subtracts Attendance rows
  // for the date automatically).
  const cohort = await StudentService.getAllStudentsFromDB(
    { absentOnDate: targetDate, limit: 1000, page: 1 },
    { page: 1, limit: 1000 },
  );

  const recipients: {
    studentId: string;
    name: string;
    mobile: string;
    channel: 'father' | 'mother' | 'self';
  }[] = [];
  const skipped: { studentId: string; name: string; reason: string }[] = [];

  for (const s of cohort.data) {
    const fatherIntl = s.fatherMobile ? toIntl(s.fatherMobile) : null;
    const motherIntl = s.motherMobile ? toIntl(s.motherMobile) : null;
    const selfIntl = toIntl(s.mobile);
    if (fatherIntl) {
      recipients.push({
        studentId: s.id,
        name: s.user.name,
        mobile: fatherIntl,
        channel: 'father',
      });
    } else if (motherIntl) {
      recipients.push({
        studentId: s.id,
        name: s.user.name,
        mobile: motherIntl,
        channel: 'mother',
      });
    } else if (selfIntl) {
      recipients.push({
        studentId: s.id,
        name: s.user.name,
        mobile: selfIntl,
        channel: 'self',
      });
    } else {
      skipped.push({
        studentId: s.id,
        name: s.user.name,
        reason: 'No valid mobile (father / mother / self)',
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
 *   1. The cron scheduler (once per matching dayOfWeek/hour/minute),
 *      with `actorId='SYSTEM'` and `actorRole='SYSTEM'`.
 *   2. The settings page "Run now" button — same call but with the
 *      signed-in admin as actor.
 *
 * The job's idempotency is enforced by `WeeklyAbsentWarning`: a row
 * per (studentId, isoYear, isoWeek) blocks re-warns for the rest of
 * the week, matching the user's "max one time in a week" rule.
 */
const runAbsentWarningJobFromDB = async (
  actorId: string,
  actorRole: 'SUPER_ADMIN' | 'ADMIN' | 'SYSTEM',
): Promise<TJobResult> => {
  const config = (await SettingsService.getConfigFromDB()).absentWarning;
  if (config.mode === 'OFF') {
    return { sent: 0, skipped: 0, total: 0, datesProcessed: [] };
  }

  // Compute the look-back window: the last `lookbackDays` calendar
  // days ending today. Non-class days naturally return zero cohort.
  const today = dayjs();
  const targetDates = Array.from(
    { length: config.lookbackDays },
    (_, i) => today.subtract(i, 'day').format('YYYY-MM-DD'),
  );

  return runForTargets(config, targetDates, actorId, actorRole);
};

/**
 * The lower-level entry point the cron scheduler uses to inject its
 * pre-computed target dates (so the "Run now" admin button can't be
 * used to backfill arbitrary past weeks without re-implementing the
 * look-back logic). Exported because the absent-warning route can
 * call it directly with a user-supplied date for one-off backfills.
 */
const runForTargets = async (
  config: TAbsentWarningConfig,
  targetDates: string[],
  actorId: string,
  actorRole: 'SUPER_ADMIN' | 'ADMIN' | 'SYSTEM',
): Promise<TJobResult> => {
  if (config.mode === 'OFF') {
    return { sent: 0, skipped: 0, total: 0, datesProcessed: targetDates };
  }

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
  // both Sunday and Monday in the look-back window, we only warn
  // them once (matches "one warning per week"), using the most-recent
  // absent-date in the substituted message.
  const perStudentAbsents = new Map<
    string,
    { name: string; mobile: string; absentDate: Date }
  >();

  for (const isoDate of targetDates) {
    const d = dayjs(isoDate).startOf('day').toDate();
    const cohort = await StudentService.getAllStudentsFromDB(
      { absentOnDate: d, limit: 1000, page: 1 },
      { page: 1, limit: 1000 },
    );
    for (const s of cohort.data) {
      if (alreadyWarned.has(s.id)) continue;
      if (perStudentAbsents.has(s.id)) continue; // earliest wins
      const fatherIntl = s.fatherMobile ? toIntl(s.fatherMobile) : null;
      const motherIntl = s.motherMobile ? toIntl(s.motherMobile) : null;
      const selfIntl = toIntl(s.mobile);
      const intlMobile = fatherIntl || motherIntl || selfIntl;
      if (!intlMobile) continue;
      perStudentAbsents.set(s.id, {
        name: s.user.name,
        mobile: intlMobile,
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
      skipped: 0,
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
    // template; the gateway just sees one body per chunk. (This is
    // the existing /api/v1/sms contract; widening it to per-row
    // messages is out of scope.)
    const dates = chunk.map((c) => dayjs(c.absentDate).format('YYYY-MM-DD'));
    const primaryDate = dates[0];
    const sampleName = chunk[0].name;
    const body = config.message
      .replaceAll('{studentName}', sampleName)
      .replaceAll('{classDate}', primaryDate);

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
    skipped,
    total: recipients.length,
    datesProcessed: targetDates,
  };
};

export const AbsentWarningService = {
  getAbsentPickerFromDB,
  runAbsentWarningJobFromDB,
  // exposed for the scheduler
  runForTargets,
};
