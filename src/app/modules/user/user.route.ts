import express from 'express';
import validateRequest from '../../middlewares/validateRequest';
import { UserController } from './user.controller';
import { UserValidation } from './user.validation';
import Auth from '../../middlewares/auth';
import { USER_ROLE } from '../../constant/userConstant';
import { writeOperationRateLimiter } from '../../middlewares/rateLimiter';

const router = express.Router();

router.post(
  '/',
  Auth(USER_ROLE.SUPER_ADMIN),
  writeOperationRateLimiter,
  validateRequest(UserValidation.createUserValidationSchema),
  UserController.createUser,
);

router.get(
  '/',
  Auth(USER_ROLE.SUPER_ADMIN),
  validateRequest(UserValidation.getAllUsersValidationSchema),
  UserController.getAllUsers,
);

router.get(
  '/:id',
  Auth(USER_ROLE.SUPER_ADMIN),
  validateRequest(UserValidation.idParamValidationSchema),
  UserController.getUserById,
);

router.patch(
  '/:id',
  Auth(USER_ROLE.SUPER_ADMIN),
  writeOperationRateLimiter,
  validateRequest(UserValidation.updateUserValidationSchema),
  UserController.updateUser,
);

router.delete(
  '/:id',
  Auth(USER_ROLE.SUPER_ADMIN),
  validateRequest(UserValidation.idParamValidationSchema),
  UserController.deleteUser,
);

export const UserRoutes = router;