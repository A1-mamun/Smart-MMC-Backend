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

// Per-slot seat-cap read-out. Used by the admit-form picker to disable
// full (batchDay, batchTime) slots. `/:id/seats` does not shadow `/:id`
// since Express matches path segments distinctly. Cached for 60s —
// admits don't change `totalSeats`, so stale-by-up-to-1m is fine, and
// `clearCourseCache()` clears this on every course write.
router.get(
  '/:id/seats',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  cache(60),
  validateRequest(CourseValidation.idParamSchema),
  CourseController.getCourseSeats,
);

router.patch(
  '/:id',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
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

router.patch(
  '/:id/status',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(CourseValidation.setStatusSchema),
  CourseController.setStatus,
);

// Independent manual override for the enrollment gate. Lives outside
// the generic PATCH /:id so the lifecycle endpoint (which keeps the
// flag in sync with `status`) is the standard path, and the override
// is an explicit single-click action an admin takes when they want
// to decouple the two for a one-off reason. See service comment for
// the override-vs-status interaction rules.
router.patch(
  '/:id/admit-another-course',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(CourseValidation.toggleAdmitAnotherCourseSchema),
  CourseController.toggleAdmitAnotherCourse,
);

export const CourseRoutes = router;
