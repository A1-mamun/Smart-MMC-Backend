/* eslint-disable @typescript-eslint/no-unused-vars, no-unused-vars */
// The cron / absent / exam-absence imports below are only used by the
// disabled auto-SMS code. Parked while the auto path is off; remove the
// disable comment when re-enabling.
import cron, { type ScheduledTask } from 'node-cron';
import dayjs from 'dayjs';
import { SettingsService } from './settings.service';
import { AbsentWarningService } from '../absentWarning/absentWarning.service';
import { ExamAbsenceWarningService } from '../examAbsenceWarning/examAbsenceWarning.service';
/* eslint-enable @typescript-eslint/no-unused-vars, no-unused-vars */
import config from '../../config';

let absentTask: ScheduledTask | null = null;
let examTask: ScheduledTask | null = null;

// In-process "fired-this-minute" latches so a slow tick cannot double-fire
// within the same minute window. We deliberately do NOT persist these —
// on process restart the scheduler resumes from the next minute slot.
/* eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars */
let absentLastFiredKey = '';
/* eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars */
let examLastFiredKey = '';

/**
 * Start BOTH cron-backed schedulers.
 *
 *   1. **absent-warning** — fires every minute, but the per-day latch
 *      collapses the tick to one run per calendar day. Targets students
 *      who had class TODAY but have no Attendance row for today. SMS
 *      goes to the father's mobile only. Always on (no Settings gate).
 *   2. **exam-absence** — fires once per day at the configured
 *      (hour, minute) and processes every absent examinee whose exam
 *      was `delayDays` ago.
 *
 * DISABLED 2026-10-01 per user request: automatic SMS sending is
 * temporarily turned off. Both cron tasks below are preserved inside
 * the comment block for easy re-enable. The exports (`startAllSchedulers`,
 * `startAbsentWarningScheduler`, `stopAllSchedulers`,
 * `stopAbsentWarningScheduler`) stay live as no-ops so server.ts and
 * any tooling keep working.
 *
 * Skipped when `config.node_env === 'test'` so `pnpm build` and CI runs
 * don't drag in cron state.
 */
export const startAllSchedulers = () => {
  if (absentTask || examTask) return;
  if (config.node_env === 'test') return;

  // ----- absent-warning tick (DISABLED — preserved for re-enable) -----
  /*
  absentTask = cron.schedule(
    '* * * * *',
    async () => {
      try {
        const now = dayjs();
        // Daily latch: fire once per YYYY-MM-DD. The minute-precision
        // latch is unnecessary because the service itself is idempotent
        // (per-ISO-week dedupe in WeeklyAbsentWarning), but capping at
        // once/day is cheaper than re-running the full cohort query on
        // every minute tick.
        const fireKey = `absent:${now.format('YYYY-MM-DD')}`;
        if (absentLastFiredKey === fireKey) return;
        absentLastFiredKey = fireKey;

        const result = await AbsentWarningService.runForTargets(
          [now.format('YYYY-MM-DD')],
          'SYSTEM',
          'SYSTEM',
        );
        if (result.total > 0) {
          console.log(
            `[absent-warning] sent=${result.sent} skipped=${result.skipped} total=${result.total} dates=${result.datesProcessed.join(',')}`,
          );
        }
      } catch (err) {
        console.error('[absent-warning scheduler]', err);
      }
    },
  );

  // ----- exam-absence tick (DISABLED — preserved for re-enable) -----
  examTask = cron.schedule(
    '* * * * *',
    async () => {
      try {
        const cfg = (await SettingsService.getConfigFromDB()).examAbsence;
        if (!cfg.enabled) return;

        const now = dayjs();
        if (now.hour() !== cfg.hour) return;
        if (now.minute() !== cfg.minute) return;

        const fireKey = `exam:${now.format('YYYY-MM-DD-HH-mm')}`;
        if (examLastFiredKey === fireKey) return;
        examLastFiredKey = fireKey;

        // Single deterministic date — exam days are atomic, no window
        // walk. The inner service handles cohort + dedupe via the
        // `(examId, studentId)` unique index on ExamAbsenceWarning.
        const targetDate = now.subtract(cfg.delayDays, 'day').startOf('day').toDate();
        const result = await ExamAbsenceWarningService.runForDate(
          targetDate,
          'SYSTEM',
          'SYSTEM',
        );
        if (result.total > 0) {
          console.log(
            `[exam-absence] sent=${result.sent} skipped=${result.skipped} total=${result.total} exams=${result.examsProcessed.length}`,
          );
        }
      } catch (err) {
        console.error('[exam-absence scheduler]', err);
      }
    },
  );

  console.log('Schedulers registered ✓ (absent-warning, exam-absence)');
  */
  void cron;
  void dayjs;
  void SettingsService;
  // Auto-SMS is parked. Manual triggers via the /settings/* POST
  // endpoints still work — they hit the no-op service stubs and
  // return clean "0 sent" responses.
  console.log('Schedulers parked ✓ (auto-SMS disabled per request)');
};

/**
 * Backwards-compatible alias — `server.ts` previously called
 * `startAbsentWarningScheduler()` and external tooling (or stray
 * references) may still expect that name. New code should call
 * `startAllSchedulers`.
 */
export const startAbsentWarningScheduler = startAllSchedulers;

export const stopAllSchedulers = () => {
  if (absentTask) {
    absentTask.stop();
    absentTask = null;
  }
  if (examTask) {
    examTask.stop();
    examTask = null;
  }
  absentLastFiredKey = '';
  examLastFiredKey = '';
};

/**
 * Backwards-compatible alias for the same reason as above.
 */
export const stopAbsentWarningScheduler = stopAllSchedulers;