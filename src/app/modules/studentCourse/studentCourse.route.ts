import express from 'express';
import validateRequest from '../../middlewares/validateRequest';
import { StudentCourseController } from './studentCourse.controller';
import { StudentCourseValidation } from './studentCourse.validation';
import Auth from '../../middlewares/auth';
import { USER_ROLE } from '../../constant/userConstant';
import { writeOperationRateLimiter } from '../../middlewares/rateLimiter';

const router = express.Router();

router.post(
  '/enroll',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(StudentCourseValidation.enrollSchema),
  StudentCourseController.enrollStudent,
);

router.post(
  '/complete/:id',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(StudentCourseValidation.idParamSchema),
  StudentCourseController.completeCourse,
);

router.get(
  '/',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  StudentCourseController.getAllEnrollments,
);

router.get(
  '/student/:studentId',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN, USER_ROLE.STUDENT),
  validateRequest(StudentCourseValidation.studentIdParamSchema),
  StudentCourseController.getStudentCourses,
);

router.delete(
  '/:id',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  validateRequest(StudentCourseValidation.idParamSchema),
  StudentCourseController.unenroll,
);

export const StudentCourseRoutes = router;