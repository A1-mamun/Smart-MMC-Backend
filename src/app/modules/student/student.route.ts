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
