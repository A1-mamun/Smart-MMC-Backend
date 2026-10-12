import express from 'express';
import validateRequest from '../../middlewares/validateRequest';
import { SettingsController } from './settings.controller';
import { SettingsValidation } from './settings.validation';
import Auth from '../../middlewares/auth';
import { USER_ROLE } from '../../constant/userConstant';
import { writeOperationRateLimiter } from '../../middlewares/rateLimiter';
import { cache } from '../../middlewares/cache';

const router = express.Router();

/**
 * Public read of the instructor-section stats. Mounted BEFORE
 * the auth-protected routes so anonymous visitors can hit it
 * from the landing page without tripping a JWT check. Cached
 * for 60s; the admin write path clears `/settings*` so a
 * super-admin edit shows up on the landing page within one
 * minute.
 */
router.get(
  '/public/instructor-section',
  cache(60),
  SettingsController.getInstructorSection,
);

// GET — visible to every admin (super_admin + admin). 60-second cache
// keeps the settings page snappy without thrashing the DB on every nav.
router.get(
  '/config',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  cache(60),
  SettingsController.getConfig,
);

// PUT — mutating the toggle / template / schedule is super-admin-only.
// Matches the existing pattern on `/user` endpoints.
router.put(
  '/config',
  Auth(USER_ROLE.SUPER_ADMIN),
  writeOperationRateLimiter,
  validateRequest(SettingsValidation.upsertConfigSchema),
  SettingsController.upsertConfig,
);

// PUT — super-admin-only upsert for the instructor section
// stats. Mirrors the `/config` PUT pattern: super admin only,
// write-rate-limited, validated by Zod. The handler clears the
// public landing-page cache so the next anonymous visitor sees
// the new values within one minute.
router.put(
  '/instructor-section',
  Auth(USER_ROLE.SUPER_ADMIN),
  writeOperationRateLimiter,
  validateRequest(SettingsValidation.upsertInstructorSectionSchema),
  SettingsController.upsertInstructorSection,
);

// POST — any admin can trigger an ad-hoc run (it's a non-mutating
// action in the sense that it doesn't change the saved config; the
// actual side effects are downstream SMS sends that the system does
// anyway on the scheduler).
router.post(
  '/absent-warning/run',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  SettingsController.runAbsentWarningNow,
);

// POST — ad-hoc run for the exam-absence job. Mirrors the absent-
// warning route: any admin can fire it, idempotency is enforced by
// the ExamAbsenceWarning (examId, studentId) unique index.
router.post(
  '/exam-absence/run',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  SettingsController.runExamAbsenceWarningNow,
);

export const SettingsRoutes = router;
