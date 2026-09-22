import express from 'express';
import validateRequest from '../../middlewares/validateRequest';
import Auth from '../../middlewares/auth';
import { writeOperationRateLimiter } from '../../middlewares/rateLimiter';
import { AbsentWarningValidation } from './absentWarning.validation';
import { AbsentWarningController } from './absentWarning.controller';

const router = express.Router();

/**
 * Manual picker — returns the list of absentees for the SMS panel's
 * "Absent on date" filter. Admin reviews the recipient list, types a
 * message, then clicks Send through the regular /api/v1/sms endpoint.
 */
router.get(
  '/picker',
  Auth('SUPER_ADMIN', 'ADMIN'),
  validateRequest(AbsentWarningValidation.pickerSchema),
  AbsentWarningController.getAbsentPicker,
);

/**
 * Synchronous "Run now" trigger. Useful for catch-up runs at end of
 * week when the cron was off / the server was down.
 */
router.post(
  '/run-now',
  Auth('SUPER_ADMIN', 'ADMIN'),
  writeOperationRateLimiter,
  AbsentWarningController.runAbsentWarningNow,
);

export const AbsentWarningRoutes = router;
