import express from 'express';
import validateRequest from '../../middlewares/validateRequest';
import { StatsController } from './stats.controller';
import { StatsValidation } from './stats.validation';
import Auth from '../../middlewares/auth';
import { USER_ROLE } from '../../constant/userConstant';
import { cache } from '../../middlewares/cache';

const router = express.Router();

router.get(
  '/admission-comparison',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  cache(120),
  validateRequest(StatsValidation.admissionComparisonSchema),
  StatsController.getAdmissionComparison,
);

router.get(
  '/batch-course',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  cache(60),
  StatsController.getBatchWiseCourseStats,
);

router.get(
  '/collection-trend',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  cache(120),
  StatsController.getCollectionTrend,
);

router.get(
  '/payment-method',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  cache(300),
  StatsController.getPaymentMethodBreakdown,
);

export const StatsRoutes = router;