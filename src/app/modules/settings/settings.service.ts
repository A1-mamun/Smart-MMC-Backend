import { JwtPayload } from 'jsonwebtoken';
import prisma from '../../utils/prisma';
import { clearCacheByPattern } from '../../utils/clearCache';
import {
  DEFAULT_ABSENT_WARNING_CONFIG,
  DEFAULT_EXAM_ABSENCE_CONFIG,
  TAbsentWarningConfig,
  TConfigPatch,
  TExamAbsenceConfig,
  TSettingsConfig,
  absentWarningConfigSchema,
  examAbsenceConfigSchema,
} from './settings.validation';

export const ABSENT_WARNING_CONFIG_KEY = 'absent_warning_sms';
export const EXAM_ABSENCE_CONFIG_KEY = 'exam_absence_sms';

/**
 * Helper that loads ONE sub-config with default fallback. We split this
 * out so both the absent-warning read path and the new exam-absence
 * read path share the same defensive "missing row → return defaults"
 * semantics.
 */
const readSubConfig = async <T>(
  key: string,
  schema: { parse: (v: unknown) => T },
  fallback: T,
): Promise<T> => {
  const row = await prisma.setting.findUnique({ where: { key } });
  if (!row) return fallback;
  return schema.parse(row.value);
};

/**
 * Fetch both feature configs in parallel. Each row falls back to its
 * in-code default if absent or corrupted (Zod parse throws → we
 * surface a 500 instead of silently returning bad data).
 */
const getConfigFromDB = async (): Promise<TSettingsConfig> => {
  const [absent, exam] = await Promise.all([
    readSubConfig(
      ABSENT_WARNING_CONFIG_KEY,
      absentWarningConfigSchema,
      DEFAULT_ABSENT_WARNING_CONFIG,
    ),
    readSubConfig(
      EXAM_ABSENCE_CONFIG_KEY,
      examAbsenceConfigSchema,
      DEFAULT_EXAM_ABSENCE_CONFIG,
    ),
  ]);
  return { absentWarning: absent, examAbsence: exam };
};

/**
 * Project a flat PATCH body onto its two sub-configs. The frontend
 * ships a single PUT covering both features; the body uses
 * `examAbsence*` for the new fields and bare names for the existing
 * absent-warning ones. `absentMessage` is accepted as a back-compat
 * alias for `message`.
 *
 * Returns `null` for a sub-config that wasn't touched, signalling to the
 * caller that no upsert is needed for that row.
 */
const projectPatch = (
  patch: TConfigPatch,
): {
  absent: Partial<TAbsentWarningConfig> | null;
  exam: Partial<TExamAbsenceConfig> | null;
} => {
  const absent: Partial<TAbsentWarningConfig> = {};
  if (patch.mode !== undefined) absent.mode = patch.mode;
  if (patch.dayOfWeek !== undefined) absent.dayOfWeek = patch.dayOfWeek;
  if (patch.hour !== undefined) absent.hour = patch.hour;
  if (patch.minute !== undefined) absent.minute = patch.minute;
  if (patch.lookbackDays !== undefined) absent.lookbackDays = patch.lookbackDays;
  // Both `message` and the legacy `absentMessage` names hit absent-warning.
  const msg = patch.message ?? patch.absentMessage;
  if (msg !== undefined) absent.message = msg;

  const exam: Partial<TExamAbsenceConfig> = {};
  if (patch.examAbsenceEnabled !== undefined) {
    exam.enabled = patch.examAbsenceEnabled;
  }
  if (patch.examAbsenceDelayDays !== undefined) {
    exam.delayDays = patch.examAbsenceDelayDays;
  }
  if (patch.examAbsenceHour !== undefined) {
    exam.hour = patch.examAbsenceHour;
  }
  if (patch.examAbsenceMinute !== undefined) {
    exam.minute = patch.examAbsenceMinute;
  }
  if (patch.examAbsenceMessage !== undefined) {
    exam.message = patch.examAbsenceMessage;
  }

  return {
    absent: Object.keys(absent).length > 0 ? absent : null,
    exam: Object.keys(exam).length > 0 ? exam : null,
  };
};

/**
 * Upsert a single sub-config row. Validation runs through the merged
 * value so a partial patch can never violate the schema (e.g. omitting
 * the `enabled` flag while flipping `delayDays`).
 */
const upsertSubConfig = async <T>(
  key: string,
  patch: Partial<T>,
  fallback: T,
  schema: { parse: (v: unknown) => T },
  actor: JwtPayload,
): Promise<T> => {
  const current = await readSubConfig(key, schema, fallback);
  const merged = schema.parse({ ...current, ...patch });

  await prisma.setting.upsert({
    where: { key },
    create: {
      key,
      // Prisma's `Json` column accepts a plain serialisable value;
      // `merged` is the parsed result of a Zod object schema so it's
      // safe. The cast bridges the generic T back to the concrete
      // Prisma input type without losing type safety on the caller side.
      value: merged as never,
      updatedBy: actor.userId,
    },
    update: {
      value: merged as never,
      updatedBy: actor.userId,
    },
  });

  return merged;
};

const upsertConfigInDB = async (
  patch: TConfigPatch,
  actor: JwtPayload,
): Promise<TSettingsConfig> => {
  const { absent, exam } = projectPatch(patch);

  // Fan out the patches. We do them sequentially rather than in
  // `Promise.all` because the same call writes `actor.userId` and we
  // want ordered activity-log rows when both fire. The cost is one
  // extra round-trip on the rare "both dirty" save — negligible.
  if (absent) {
    await upsertSubConfig(
      ABSENT_WARNING_CONFIG_KEY,
      absent,
      DEFAULT_ABSENT_WARNING_CONFIG,
      absentWarningConfigSchema,
      actor,
    );
  }
  if (exam) {
    await upsertSubConfig(
      EXAM_ABSENCE_CONFIG_KEY,
      exam,
      DEFAULT_EXAM_ABSENCE_CONFIG,
      examAbsenceConfigSchema,
      actor,
    );
  }

  // Evict any cached GET /api/v1/settings* so the next read returns
  // fresh data. Cache middleware keys on the URL path, so a broad
  // pattern catches /settings/config and the new /settings/exam-absence/run.
  if (absent || exam) {
    await clearCacheByPattern('cache:/api/v1/settings*').catch(() => undefined);
  }

  return getConfigFromDB();
};

export const SettingsService = {
  getConfigFromDB,
  upsertConfigInDB,
};

// Re-export the validation-side helpers so callers (scheduler, examAbsence
// service) can keep one consistent import path.
export {
  DEFAULT_ABSENT_WARNING_CONFIG,
  DEFAULT_EXAM_ABSENCE_CONFIG,
} from './settings.validation';
export type {
  TAbsentWarningConfig,
  TExamAbsenceConfig,
  TSettingsConfig,
} from './settings.validation';
