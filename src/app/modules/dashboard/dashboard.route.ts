import express from 'express';
import { DashboardController } from './dashboard.controller';
import Auth from '../../middlewares/auth';
import { USER_ROLE } from '../../constant/userConstant';
import { cache } from '../../middlewares/cache';

const router = express.Router();

router.get(
  '/admin',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  cache(60),
  DashboardController.getAdminDashboard,
);

router.get(
  '/student',
  Auth(USER_ROLE.STUDENT),
  DashboardController.getStudentDashboard,
);

export const DashboardRoutes = router;