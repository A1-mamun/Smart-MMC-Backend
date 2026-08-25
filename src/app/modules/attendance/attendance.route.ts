import express from 'express';
import validateRequest from '../../middlewares/validateRequest';
import { AttendanceController } from './attendance.controller';
import { AttendanceValidation } from './attendance.validation';
import Auth from '../../middlewares/auth';
import { USER_ROLE } from '../../constant/userConstant';
import { heavyOperationRateLimiter, writeOperationRateLimiter } from '../../middlewares/rateLimiter';
import config from '../../config';
import AppError from '../../errors/AppError';
import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync';

const router = express.Router();

const requireDeviceSecret = catchAsync(async (req, _res, next) => {
  const secret = req.headers['x-device-secret'];
  if (!secret || secret !== config.deviceSecret) {
    throw new AppError(httpStatus.UNAUTHORIZED, 'Invalid device secret');
  }
  next();
});

router.post(
  '/check-in',
  requireDeviceSecret,
  heavyOperationRateLimiter,
  validateRequest(AttendanceValidation.checkInSchema),
  AttendanceController.checkIn,
);

router.post(
  '/manual',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(AttendanceValidation.manualCheckInSchema),
  AttendanceController.manualCheckIn,
);

router.get(
  '/today',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  validateRequest(AttendanceValidation.getTodaySchema),
  AttendanceController.getToday,
);

router.get(
  '/stats',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  AttendanceController.getStats,
);

router.get(
  '/student/:studentId',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN, USER_ROLE.STUDENT),
  validateRequest(AttendanceValidation.getStudentAttendanceSchema),
  AttendanceController.getStudentAttendance,
);

router.delete(
  '/:id',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  validateRequest(AttendanceValidation.idParamSchema),
  AttendanceController.deleteAttendance,
);

export const AttendanceRoutes = router;