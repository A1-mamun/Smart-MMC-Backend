import express from 'express';
import validateRequest from '../../middlewares/validateRequest';
import { SettingsController } from './settings.controller';
import { SettingsValidation } from './settings.validation';
import Auth from '../../middlewares/auth';
import { USER_ROLE } from '../../constant/userConstant';
import { writeOperationRateLimiter } from '../../middlewares/rateLimiter';
import { cache } from '../../middlewares/cache';

const router = express.Router();

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
