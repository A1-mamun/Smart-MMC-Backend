import express from 'express';
import validateRequest from '../../middlewares/validateRequest';
import { AuthController } from './auth.controller';
import { AuthValidation } from './auth.validation';
import Auth from '../../middlewares/auth';
import { USER_ROLE } from '../../constant/userConstant';
import { authRateLimiter, passwordResetRateLimiter } from '../../middlewares/rateLimiter';

const router = express.Router();

router.post(
  '/sign-in',
  authRateLimiter,
  validateRequest(AuthValidation.loginValidationSchema),
  AuthController.signInUser,
);

router.post(
  '/refresh-token',
  validateRequest(AuthValidation.refreshTokenValidationSchema),
  AuthController.refreshToken,
);

router.post('/logout', AuthController.logout);

router.post(
  '/change-password',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN, USER_ROLE.STUDENT),
  validateRequest(AuthValidation.changePasswordValidationSchema),
  AuthController.changePassword,
);

router.post(
  '/forgot-password',
  passwordResetRateLimiter,
  validateRequest(AuthValidation.forgotPasswordValidationSchema),
  AuthController.forgotPassword,
);

router.post(
  '/reset-password',
  passwordResetRateLimiter,
  validateRequest(AuthValidation.resetPasswordValidationSchema),
  AuthController.resetPassword,
);

router.get(
  '/me',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN, USER_ROLE.STUDENT),
  AuthController.getMe,
);

export const AuthRoutes = router;