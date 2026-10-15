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

router.get(
  '/ongoing-courses',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  // No cache — the response shape is role-gated (SUPER_ADMIN sees
  // totalEarned / ppFeeTotal / netProfit; ADMIN sees 0s), and the
  // shared cache key would leak the super-admin numbers to admins
  // for the TTL window. The admit / payment flows already invalidate
  // student + payment caches, and the dashboard re-fetches on mount,
  // so the DB cost on each mount is bounded by `count(courses where
  // status=ONGOING)` — typically a handful.
  StatsController.getOngoingCourseStats,
);

export const StatsRoutes = router;