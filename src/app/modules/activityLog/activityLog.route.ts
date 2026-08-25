import express from 'express';
import validateRequest from '../../middlewares/validateRequest';
import { ActivityLogController } from './activityLog.controller';
import { ActivityLogValidation } from './activityLog.validation';
import Auth from '../../middlewares/auth';
import { USER_ROLE } from '../../constant/userConstant';
import { cache } from '../../middlewares/cache';

const router = express.Router();

router.get(
  '/',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  cache(30),
  validateRequest(ActivityLogValidation.getAllActivitySchema),
  ActivityLogController.getAllActivities,
);

router.get(
  '/recent',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  ActivityLogController.getRecent,
);

export const ActivityLogRoutes = router;