import express from 'express';
import validateRequest from '../../middlewares/validateRequest';
import { CourseController } from './course.controller';
import { CourseValidation } from './course.validation';
import Auth from '../../middlewares/auth';
import { USER_ROLE } from '../../constant/userConstant';
import { cache } from '../../middlewares/cache';
import { writeOperationRateLimiter } from '../../middlewares/rateLimiter';

const router = express.Router();

router.post(
  '/',
  Auth(USER_ROLE.SUPER_ADMIN),
  writeOperationRateLimiter,
  validateRequest(CourseValidation.createCourseSchema),
  CourseController.createCourse,
);

router.get(
  '/',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN, USER_ROLE.STUDENT),
  cache(300),
  validateRequest(CourseValidation.getAllCoursesSchema),
  CourseController.getAllCourses,
);

router.get(
  '/:id',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN, USER_ROLE.STUDENT),
  validateRequest(CourseValidation.idParamSchema),
  CourseController.getCourseById,
);

router.patch(
  '/:id',
  Auth(USER_ROLE.SUPER_ADMIN),
  writeOperationRateLimiter,
  validateRequest(CourseValidation.updateCourseSchema),
  CourseController.updateCourse,
);

router.delete(
  '/:id',
  Auth(USER_ROLE.SUPER_ADMIN),
  validateRequest(CourseValidation.idParamSchema),
  CourseController.deleteCourse,
);

router.patch(
  '/:id/toggle-active',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(CourseValidation.toggleActiveSchema),
  CourseController.toggleActive,
);

export const CourseRoutes = router;