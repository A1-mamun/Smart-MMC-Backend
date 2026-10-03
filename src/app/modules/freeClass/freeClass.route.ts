import express from 'express';
import validateRequest from '../../middlewares/validateRequest';
import Auth from '../../middlewares/auth';
import { USER_ROLE } from '../../constant/userConstant';
import { authRateLimiter, freeClassRateLimiter } from '../../middlewares/rateLimiter';
import { FreeClassValidation } from './freeClass.validation';
import { FreeClassController } from './freeClass.controller';

const router = express.Router();

// Public routes ────────────────────────────────────────────────────────────
router.post(
  '/signup',
  freeClassRateLimiter,
  validateRequest(FreeClassValidation.signupSchema),
  FreeClassController.signUpFreeStudent,
);

router.post(
  '/login',
  authRateLimiter,
  validateRequest(FreeClassValidation.loginSchema),
  FreeClassController.freeLogin,
);

// Authed routes ────────────────────────────────────────────────────────────
// STUDENT covers both free-class accounts (isFreeAccount=true) and paid
// students. Admins can also browse the tree to sanity-check content.
router.get(
  '/content',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN, USER_ROLE.STUDENT),
  FreeClassController.getFreeContent,
);

router.get(
  '/content/:topicId/play',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN, USER_ROLE.STUDENT),
  validateRequest(FreeClassValidation.topicIdParam),
  FreeClassController.getFreeTopicPlayback,
);

export const FreeClassRoutes = router;
