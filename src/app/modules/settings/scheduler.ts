import cron, { type ScheduledTask } from 'node-cron';
import dayjs from 'dayjs';
import { SettingsService } from './settings.service';
import { AbsentWarningService } from '../absentWarning/absentWarning.service';
import { ExamAbsenceWarningService } from '../examAbsenceWarning/examAbsenceWarning.service';
import config from '../../config';

let absentTask: ScheduledTask | null = null;
let examTask: ScheduledTask | null = null;

// In-process "fired-this-minute" latches so a slow tick cannot double-fire
// within the same minute window. We deliberately do NOT persist these —
// on process restart the scheduler resumes from the next minute slot.
let absentLastFiredKey = '';
let examLastFiredKey = '';

/**
 * Start BOTH cron-backed schedulers. Each ticks every minute; the per-task
 * guard clauses bail early if the configuration says so.
 *
 *   1. **absent-warning** — fires on the configured (dayOfWeek, hour, minute)
 *      and walks the look-back window. Late or early ticks are no-ops.
 *   2. **exam-absence** — fires once per day at the configured
 *      (hour, minute) and processes every absent examinee whose exam was
 *      `delayDays` ago.
 *
 * The look-back window is `cfg.lookbackDays` calendar days ending today
 * — for each, the absent-warning inner job filters down to students
 * whose BatchDay hits that weekday (so non-class days naturally no-op).
 *
 * Skipped when `config.node_env === 'test'` so `pnpm build` and CI runs
 * don't drag in cron state.
 */
export const startAllSchedulers = () => {
  if (absentTask || examTask) return;
  if (config.node_env === 'test') return;

  // ----- absent-warning tick (unchanged behaviour) -----
  absentTask = cron.schedule(
    '* * * * *',
    async () => {
      try {
        const cfg = (await SettingsService.getConfigFromDB()).absentWarning;
        if (cfg.mode !== 'AUTO') return;

        const now = dayjs();
        const dow = now.format('dddd');
        if (cfg.dayOfWeek !== dow) return;
        if (now.hour() !== cfg.hour) return;
        if (now.minute() !== cfg.minute) return;

        const fireKey = `${now.format('YYYY-MM-DD-HH-mm')}`;
        if (absentLastFiredKey === fireKey) return;
        absentLastFiredKey = fireKey;

        // Walk back `lookbackDays` calendar days. The inner service
        // applies the BatchDay weekday filter so non-class days are a
        // near-zero-cost no-op.
        const targetDates = Array.from(
          { length: cfg.lookbackDays },
          (_, i) => now.subtract(i, 'day').format('YYYY-MM-DD'),
        );

        const result = await AbsentWarningService.runForTargets(
          cfg,
          targetDates,
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

  // ----- exam-absence tick (new) -----
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
