import express from 'express';
import validateRequest from '../../middlewares/validateRequest';
import { StudentController } from './student.controller';
import { StudentValidation } from './student.validation';
import Auth from '../../middlewares/auth';
import { USER_ROLE } from '../../constant/userConstant';
import { writeOperationRateLimiter } from '../../middlewares/rateLimiter';
import { cache } from '../../middlewares/cache';

const router = express.Router();

router.post(
  '/admit',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(StudentValidation.admitStudentSchema),
  StudentController.admitStudent,
);

// Dedicated endpoint for "old student → new course" enrollment. Same
// auth + rate-limit posture as /admit, but a tighter payload (only the
// fields that drive the reuse flow). The full /admit endpoint still
// supports the reuse case for backward compatibility — it just falls
// through to the same service helper after detecting an existing
// mobile.
router.post(
  '/enroll-existing',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(StudentValidation.enrollExistingStudentSchema),
  StudentController.enrollExistingStudent,
);

router.get(
  '/',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  cache(60),
  validateRequest(StudentValidation.getAllStudentsSchema),
  StudentController.getAllStudents,
);

router.get('/me/profile', Auth(USER_ROLE.STUDENT), StudentController.getMyProfile);

router.get(
  '/:id',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  validateRequest(StudentValidation.idParamSchema),
  StudentController.getStudentById,
);

router.patch(
  '/:id',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(StudentValidation.updateStudentSchema),
  StudentController.updateStudent,
);

router.delete(
  '/:id',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  validateRequest(StudentValidation.deleteStudentSchema),
  StudentController.deleteStudent,
);

export const StudentRoutes = router;
