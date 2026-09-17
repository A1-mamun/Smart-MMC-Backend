import express from 'express';
import validateRequest from '../../middlewares/validateRequest';
import { SmsController } from './sms.controller';
import { SmsValidation } from './sms.validation';
import Auth from '../../middlewares/auth';
import { USER_ROLE } from '../../constant/userConstant';
import { writeOperationRateLimiter } from '../../middlewares/rateLimiter';

const router = express.Router();

router.post(
  '/',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(SmsValidation.sendSmsSchema),
  SmsController.sendSms,
);

router.get('/balance', Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN), SmsController.getBalance);

router.get(
  '/logs',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  validateRequest(SmsValidation.getMyLogsSchema),
  SmsController.getMyLogs,
);

export const SmsRoutes = router;
