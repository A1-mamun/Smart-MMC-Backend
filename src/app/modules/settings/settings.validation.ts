import { z } from 'zod';

/**
 * The absent-warning feature no longer has user-tunable knobs. The
 * scheduler is always on (daily tick), the target date is always
 * "today", the SMS goes to the father's mobile only, and the message
 * body is hardcoded in `absentWarning.service.ts`. We keep the
 * `absent_warning_sms` Setting row around for backward compatibility
 * with already-deployed dashboards, but its shape is empty.
 *
 * Historical field reference (removed by this PR):
 *   - mode ('OFF' | 'MANUAL' | 'AUTO')
 *   - dayOfWeek + hour + minute (cron schedule)
 *   - lookbackDays (1..3)
 *   - message template
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

/**
 * Absent-warning is now a constant-time, father-only, today-only job.
 * The Settings row is kept (shape: empty object) for backwards compat
 * with already-deployed clients that still issue a GET against this
 * key. We accept ANY value here and the service code never reads it.
 */
export const absentWarningConfigSchema = z.object({}).passthrough();

/**
 * PATCH-shaped upsert: every field optional, server merges with the
 * stored config + re-validates the merged result. Lets the UI split a
 * "Save" into partial edits without resubmitting the whole form.
 *
 * The absent-warning PATCH fields (mode/dayOfWeek/hour/minute/lookbackDays/
 * message/absentMessage) have been removed — the feature is no longer
 * user-configurable. Only the exam-absence fields remain.
 */
export const upsertConfigSchema = z.object({
  body: z
    .object({
      // exam-absence (the only remaining user-tunable feature)
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

/**
 * Absent-warning default is an empty object — the service never reads
 * it. Kept so the GET path can still return a valid (empty) shape when
 * the row is missing.
 */
export const DEFAULT_ABSENT_WARNING_CONFIG: TAbsentWarningConfig = {};

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
  // absentWarning: TAbsentWarningConfig;
  examAbsence: TExamAbsenceConfig;
};

/**
 * Instructor-section "stats" config. Surfaced on the public
 * landing page next to the lead-instructor bio; editable from
 * the super-admin Settings page so the headline numbers (e.g.
 * "10+ Years Teaching", "10000+ Students Mentored") can be
 * refreshed without a deploy.
 *
 * `value` is a freeform short string (e.g. "10+", "2000+",
 * "95%") — anything that fits a single-line stat label.
 * `label` is the human-readable caption (e.g. "Years Teaching",
 * "Placed to Top Universities"). Order in the array = order on
 * the landing page. We cap at 6 entries to keep the layout
 * tidy; the current layout is a 3-col grid on `sm+`.
 */
const instructorStatSchema = z.object({
  value: z
    .string()
    .trim()
    .min(1, 'Stat value is required')
    .max(20, 'Stat value must be 20 characters or fewer'),
  label: z
    .string()
    .trim()
    .min(1, 'Stat label is required')
    .max(60, 'Stat label must be 60 characters or fewer'),
});

export const instructorSectionSchema = z.object({
  stats: z
    .array(instructorStatSchema)
    .min(1, 'At least one stat is required')
    .max(6, 'Maximum 6 stats are allowed'),
  /**
   * Optional pull-quote rendered under the lead-instructor
   * name on the public landing page. Empty / missing → the
   * section omits the quote block entirely. The 500-char cap
   * mirrors the existing bio description so the quote can't
   * blow up the card layout.
   */
  quote: z.string().trim().max(500).optional().nullable(),
});

/**
 * PATCH-shaped upsert for the instructor section. Mirrors the
 * exam-absence pattern: every field optional, server merges
 * with the stored row + re-validates the merged result before
 * writing. A full `stats: []` replacement is the only way to
 * update the list (no per-index PATCH) — the admin UI is
 * simple enough that re-saving the whole list per edit is
 * cheaper than building a sparse PATCH protocol.
 *
 * `quote` uses `.nullish()` semantics: an empty string, `null`,
 * or `undefined` all clear the stored quote (the public page
 * then omits the block). To preserve the existing value, omit
 * the field entirely.
 */
export const upsertInstructorSectionSchema = z.object({
  body: z.object({
    stats: z.array(instructorStatSchema).min(1).max(6).optional(),
    quote: z
      .string()
      .trim()
      .max(500, 'Quote must be 500 characters or fewer')
      .nullish(),
  }),
});

export const SettingsValidation = {
  upsertConfigSchema,
  upsertInstructorSectionSchema,
};

export type TInstructorStat = z.infer<typeof instructorStatSchema>;
export type TInstructorSection = z.infer<typeof instructorSectionSchema>;
export type TInstructorSectionPatch = z.infer<
  typeof upsertInstructorSectionSchema
>['body'];

/**
 * Default stats — what the landing page shows before the
 * super admin has saved anything. Mirrors the values that
 * were hardcoded in `InstructorSection.tsx` before this
 * feature went dynamic, so a freshly-deployed instance
 * doesn't render an empty stats row.
 */
export const DEFAULT_INSTRUCTOR_STATS: TInstructorStat[] = [
  { value: '10+', label: 'Years Teaching' },
  { value: '10000+', label: 'Students Mentored' },
  { value: '2000+', label: 'Placed to Top Universities' },
];

export const DEFAULT_INSTRUCTOR_SECTION: TInstructorSection = {
  stats: DEFAULT_INSTRUCTOR_STATS,
  // Pre-fill the original quote so a freshly-deployed instance
  // keeps the same hero copy until the super admin edits it.
  quote:
    "Education isn't about memorising answers — it's about building thinkers. Every student who walks in here deserves a teacher who believes in them first.",
};

export { weekdayEnum };
