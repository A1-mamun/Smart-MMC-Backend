import { z } from 'zod';

/**
 * Single config row that drives the absent-warning feature. Persisted in
 * the generic `Setting` table keyed by `absent_warning_sms`. The radio
 * semantics on `mode`:
 *   - OFF    → the entire feature is disabled; the scheduler is silent
 *              and the "Absent on date" picker shows no rows.
 *   - MANUAL → admins send warnings from the SMS panel ad-hoc; no cron.
 *   - AUTO   → the scheduler fires on (dayOfWeek, hour, minute) every week.
 */
const weekdayEnum = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export const ABSENT_WARNING_MODES = ['OFF', 'MANUAL', 'AUTO'] as const;

/**
 * Exam-absence father-warning feature. Persisted in the same generic
 * `Setting` table under the `exam_absence_sms` key.
 *
 *   - `enabled` is the master ON/OFF switch (default OFF).
 *   - `delayDays` is the gap between Exam.examDate and the SMS dispatch
 *     day. Default 2 — matches the user's literal "2 days after examination"
 *     rule. Configurable 1..7 so a super admin can tune it without a migration.
 *   - `hour`/`minute` are server-local TZ time-of-day. The cron ticks every
 *     minute and fires when the wall clock matches.
 *   - `message` supports three placeholders: {studentName}, {examTitle},
 *     {examDate} (formatted YYYY-MM-DD). Same 1600-char cap as the existing
 *     absent-warning template.
 *
 * Gating: ONLY absent examinees (`ExamResult.isAbsent = true`) whose exam
 * was `delayDays` ago AND have no `ExamAbsenceWarning` row yet will receive
 * the SMS. If `Exam.isResultPublished = true`, the exam is excluded —
 * results are final, no nag.
 */
export const examAbsenceConfigSchema = z.object({
  enabled: z.boolean(),
  delayDays: z.coerce.number().int().min(1).max(7),
  hour: z.coerce.number().int().min(0).max(23),
  minute: z.coerce.number().int().min(0).max(59),
  message: z.string().min(1).max(1600),
});

export const absentWarningConfigSchema = z.object({
  mode: z.enum(ABSENT_WARNING_MODES),
  dayOfWeek: z.enum(weekdayEnum),
  hour: z.coerce.number().int().min(0).max(23),
  minute: z.coerce.number().int().min(0).max(59),
  // 1600-char cap matches the existing sendSmsSchema message cap.
  message: z.string().min(1).max(1600),
  // 1..3 — how many past calendar days to consider per tick. The default
  // of 1 matches the user's example ("Sunday class → warn on Tuesday at
  // 10:00 → look back 1 day which is Monday, hmm").
  // In practice the scheduler skips non-class days naturally because
  // getAllStudentsFromDB({ classDate }) returns 0 rows for them.
  lookbackDays: z.coerce.number().int().min(1).max(3),
});

/**
 * PATCH-shaped upsert: every field optional, server merges with the
 * stored config + re-validates the merged result. Lets the UI split a
 * "Save" into partial edits without resubmitting the whole form.
 *
 * One endpoint serves BOTH features. The body is flat — `mode` etc. for
 * the absent-warning and `examAbsence*` for the exam-absence — and the
 * server projects them onto the right underlying Setting row before
 * persisting. The `message` field is mapped to absent-warning; the new
 * `examAbsenceMessage` is mapped to the exam template.
 */
export const upsertConfigSchema = z.object({
  body: z
    .object({
      // absent-warning (existing)
      mode: z.enum(ABSENT_WARNING_MODES).optional(),
      dayOfWeek: z.enum(weekdayEnum).optional(),
      hour: z.coerce.number().int().min(0).max(23).optional(),
      minute: z.coerce.number().int().min(0).max(59).optional(),
      // Both `message` and `absentMessage` resolve to the absent-warning
      // template; `absentMessage` exists for backward compat with any
      // saved dashboards.
      message: z.string().min(1).max(1600).optional(),
      absentMessage: z.string().min(1).max(1600).optional(),
      lookbackDays: z.coerce.number().int().min(1).max(3).optional(),
      // exam-absence (new)
      examAbsenceEnabled: z.boolean().optional(),
      examAbsenceDelayDays: z.coerce.number().int().min(1).max(7).optional(),
      examAbsenceHour: z.coerce.number().int().min(0).max(23).optional(),
      examAbsenceMinute: z.coerce.number().int().min(0).max(59).optional(),
      examAbsenceMessage: z.string().min(1).max(1600).optional(),
    })
    .refine((b) => Object.keys(b).length > 0, {
      message: 'At least one field is required',
    }),
});

export type TAbsentWarningConfig = z.infer<typeof absentWarningConfigSchema>;
export type TExamAbsenceConfig = z.infer<typeof examAbsenceConfigSchema>;
// Flat patch shape — same field names the UI sends, before the server
// fans them out to the right sub-config.
export type TConfigPatch = z.infer<typeof upsertConfigSchema>['body'];

export const DEFAULT_ABSENT_WARNING_CONFIG: TAbsentWarningConfig = {
  mode: 'MANUAL',
  dayOfWeek: 'Tuesday',
  hour: 10,
  minute: 0,
  message:
    'Dear parent, your ward {studentName} was absent from class on {classDate}. Please ensure regular attendance.',
  lookbackDays: 1,
};

export const DEFAULT_EXAM_ABSENCE_CONFIG: TExamAbsenceConfig = {
  enabled: false,
  delayDays: 2,
  hour: 10,
  minute: 0,
  message:
    'Dear parent, your ward {studentName} was absent from the exam "{examTitle}" held on {examDate}. Please contact the academy.',
};

/**
 * Combined container shape returned by GET/PUT /settings/config. The
 * Redux slice on the frontend dereferences both sub-configs through
 * this same envelope.
 */
export type TSettingsConfig = {
  absentWarning: TAbsentWarningConfig;
  examAbsence: TExamAbsenceConfig;
};

export const SettingsValidation = {
  upsertConfigSchema,
};

export { weekdayEnum };
