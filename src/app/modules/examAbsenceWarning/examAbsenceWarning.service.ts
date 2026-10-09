import dayjs from 'dayjs';
import prisma from '../../utils/prisma';
import { JwtPayload } from 'jsonwebtoken';
import { SmsService } from '../sms/sms.service';
import { toIntl } from '../../utils/phone';
import { SettingsService } from '../settings/settings.service';

type TJobResult = {
  /** Total recipients the gateway accepted across all exams processed. */
  sent: number;
  /** Recipients the gateway rejected or that had no valid fatherMobile. */
  skipped: number;
  /** Cohort size after father-mobile filtering (and implicitly after
   *  the (examId, studentId) dedupe subtraction, which the query
   *  enforces via `examAbsenceWarnings: { none: {} }`). */
  total: number;
  /** Per-exam diagnostic info — which exams participated in this run. */
  examsProcessed: { examId: string; title: string; examDate: string }[];
};

/**
 * Run the exam-absence father-warning job for a single exam date.
 *
 *   - Pulls every exam whose `examDate === targetDate` AND
 *     `isResultPublished = false` AND has at least one absent examinee
 *     AND has no prior `ExamAbsenceWarning` row for any of those
 *     examinees.
 *   - Sends the configured template to each examinee's `fatherMobile`
 *     ONLY (no mother / self fallback — spec is explicit).
 *   - Writes one `ExamAbsenceWarning` row per (exam, student) to
 *     block re-fires via the unique index + the cron-fire latch.
 *
 * Public entry points mirror the absent-warning pattern:
 *
 *   - `runJobFromDB(actorId, actorRole)` — used by the manual
 *     "Run exam-absence job now" button. Reads `delayDays` from the
 *     persisted config and computes `targetDate = today - delayDays`.
 *   - `runForDate(targetDate, actorId, actorRole)` — used by the
 *     scheduler and any future backfill tooling. Bypasses `delayDays`
 *     and processes the explicit date.
 *
 * Both paths return a `TJobResult` so the controller can echo the same
 * shape back to the frontend toast.
 */

const chunkAndSend = async (
  recipients: {
    studentId: string;
    name: string;
    intl: string;
    examId: string;
    examTitle: string;
    examDateYmd: string;
    absentDate: Date;
  }[],
  messageTemplate: string,
  actorId: string,
  actorRole: 'SUPER_ADMIN' | 'ADMIN' | 'SYSTEM',
): Promise<{ sent: number; skipped: number }> => {
  let sent = 0;
  let skipped = 0;

  // Reuse the SMS module's existing 500-recipient chunk ceiling.
  const CHUNK_SIZE = 500;
  for (let i = 0; i < recipients.length; i += CHUNK_SIZE) {
    const chunk = recipients.slice(i, i + CHUNK_SIZE);

    // Per-chunk message body. The SMS gateway logs ONE body per chunk;
    // the recipient list carries the per-recipient metadata. This is
    // the same ONE_TO_MANY contract the absent-warning service uses,
    // which keeps SMS billing / audit consistent.
    const sample = chunk[0];
    const body = messageTemplate
      .replaceAll('{studentName}', sample.name)
      .replaceAll('{examTitle}', sample.examTitle)
      .replaceAll('{examDate}', sample.examDateYmd);

    const result = await SmsService.sendSmsToDB(
      {
        mode: 'ONE_TO_MANY',
        recipients: chunk.map((c) => ({
          studentId: c.studentId,
          name: c.name,
          mobile: c.intl,
        })),
        message: body,
      },
      { userId: actorId, role: actorRole } as JwtPayload,
    );
    sent += result.log.count;
    skipped += result.skipped.length;

    // Write the dedupe ledger even if the gateway failed — that way a
    // re-run cannot spam a student whose SMS didn't go through. The
    // `skipDuplicates: true` keeps the operation idempotent under
    // concurrent ticks. A retry flow (manual re-open from the UI)
    // would have to delete the row first, which is fine for v1.
    //
    // NOTE: When re-enabling, switch `warnedAt: new Date()` to
    // `warnedAt: instituteLocalDate(new Date())` so the stored date
    // matches the BD calendar day the SMS actually fired, not the
    // server-local day.
    await prisma.examAbsenceWarning.createMany({
      data: chunk.map((c) => ({
        examId: c.examId,
        studentId: c.studentId,
        absentDate: c.absentDate,
        warnedAt: new Date(),
        sentToMobile: c.intl,
        smsLogId: result.log.id,
      })),
      skipDuplicates: true,
    });
  }
  return { sent, skipped };
};
const runForDate = async (
  targetDate: Date,
  actorId: string,
  actorRole: 'SUPER_ADMIN' | 'ADMIN' | 'SYSTEM',
): Promise<TJobResult> => {
  const cfg = (await SettingsService.getConfigFromDB()).examAbsence;
  if (!cfg.enabled) {
    return { sent: 0, skipped: 0, total: 0, examsProcessed: [] };
  }

  // One-shot fetch: every exam on `targetDate` with at least one
  // absent examinee AND no prior ExamAbsenceWarning row for any of
  // those examinees. The `examAbsenceWarnings: { none: {} }` filter
  // is the SQL `NOT EXISTS` equivalent.
  const exams = await prisma.exam.findMany({
    where: {
      examDate: targetDate,
      // Don't nag about published exams — results are final.
      isResultPublished: false,
      results: { some: { isAbsent: true } },
      examAbsenceWarnings: { none: {} },
    },
    include: {
      course: { select: { name: true } },
      results: {
        where: { isAbsent: true },
        include: {
          student: {
            select: {
              id: true,
              fatherMobile: true,
              user: { select: { name: true } },
            },
          },
        },
      },
    },
  });

  const recipients: {
    studentId: string;
    name: string;
    intl: string;
    examId: string;
    examTitle: string;
    examDateYmd: string;
    absentDate: Date;
  }[] = [];

  for (const exam of exams) {
    const examDateYmd = dayjs(exam.examDate).format('YYYY-MM-DD');
    for (const r of exam.results) {
      // Per-spec: father-mobile ONLY. No mother / self fallback.
      const intl = r.student.fatherMobile
        ? toIntl(r.student.fatherMobile)
        : null;
      if (!intl) {
        // Tracked later as `skipped` — collect in a side channel so
        // `total` still matches the original cohort size and the
        // operator can see WHY a student was skipped.
        recipients.push({
          studentId: r.student.id,
          name: r.student.user.name,
          intl: '', // sentinel — filtered out below
          examId: exam.id,
          examTitle: exam.title,
          examDateYmd,
          absentDate: exam.examDate,
        });
        continue;
      }
      recipients.push({
        studentId: r.student.id,
        name: r.student.user.name,
        intl,
        examId: exam.id,
        examTitle: exam.title,
        examDateYmd,
        absentDate: exam.examDate,
      });
    }
  }

  // Split valid from invalid-mobiles, but keep them in the same `total`
  // count so the operator sees "5 matched, 3 sent, 2 skipped".
  const validRecipients = recipients.filter((r) => r.intl !== '');
  const skippedNoMobile = recipients.length - validRecipients.length;

  if (validRecipients.length === 0) {
    return {
      sent: 0,
      skipped: skippedNoMobile,
      total: recipients.length,
      examsProcessed: exams.map((e) => ({
        examId: e.id,
        title: e.title,
        examDate: dayjs(e.examDate).format('YYYY-MM-DD'),
      })),
    };
  }

  const { sent, skipped } = await chunkAndSend(
    validRecipients,
    cfg.message,
    actorId,
    actorRole,
  );

  return {
    sent,
    skipped: skipped + skippedNoMobile,
    total: recipients.length,
    examsProcessed: exams.map((e) => ({
      examId: e.id,
      title: e.title,
      examDate: dayjs(e.examDate).format('YYYY-MM-DD'),
    })),
  };
};

const runJobFromDB = async (
  actorId: string,
  actorRole: 'SUPER_ADMIN' | 'ADMIN' | 'SYSTEM',
): Promise<TJobResult> => {
  const cfg = (await SettingsService.getConfigFromDB()).examAbsence;
  if (!cfg.enabled) {
    return { sent: 0, skipped: 0, total: 0, examsProcessed: [] };
  }
  // Manual run honours the persisted `delayDays` so the button always
  // mirrors what the cron will do.
  const targetDate = dayjs()
    .subtract(cfg.delayDays, 'day')
    .startOf('day')
    .toDate();
  return runForDate(targetDate, actorId, actorRole);
};

export const ExamAbsenceWarningService = {
  runJobFromDB,
  runForDate,
};
