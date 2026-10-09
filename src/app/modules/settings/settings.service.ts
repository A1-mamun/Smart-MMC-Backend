/* eslint-disable no-unused-vars */
import { JwtPayload } from 'jsonwebtoken';
import prisma from '../../utils/prisma';
import { clearCacheByPattern } from '../../utils/clearCache';
import {
  // DEFAULT_ABSENT_WARNING_CONFIG,
  DEFAULT_EXAM_ABSENCE_CONFIG,
  TConfigPatch,
  TExamAbsenceConfig,
  TSettingsConfig,
  // absentWarningConfigSchema,
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
  // const [absent, exam] = await Promise.all([
  const [exam] = await Promise.all([
    // readSubConfig(
    //   ABSENT_WARNING_CONFIG_KEY,
    //   absentWarningConfigSchema,
    //   DEFAULT_ABSENT_WARNING_CONFIG,
    // ),
    readSubConfig(EXAM_ABSENCE_CONFIG_KEY, examAbsenceConfigSchema, DEFAULT_EXAM_ABSENCE_CONFIG),
  ]);
  // return { absentWarning: absent, examAbsence: exam };
  return { examAbsence: exam };
};

/**
 * Project a flat PATCH body onto its (single) sub-config. The
 * absent-warning feature no longer accepts user edits — its only
 * sub-config is exam-absence, which is keyed by `examAbsence*` in the
 * body.
 *
 * Returns `null` for a sub-config that wasn't touched, signalling to
 * the caller that no upsert is needed for that row.
 */
const projectPatch = (
  patch: TConfigPatch,
): {
  exam: Partial<TExamAbsenceConfig> | null;
} => {
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
  const { exam } = projectPatch(patch);

  // Only the exam-absence sub-config is user-tunable now. The
  // absent-warning row is read-only (always served from
  // DEFAULT_ABSENT_WARNING_CONFIG if missing).
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
  if (exam) {
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
export { DEFAULT_ABSENT_WARNING_CONFIG, DEFAULT_EXAM_ABSENCE_CONFIG } from './settings.validation';
export type {
  TAbsentWarningConfig,
  TExamAbsenceConfig,
  TSettingsConfig,
} from './settings.validation';
