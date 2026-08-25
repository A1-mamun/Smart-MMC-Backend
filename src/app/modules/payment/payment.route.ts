import express from 'express';
import validateRequest from '../../middlewares/validateRequest';
import { PaymentController } from './payment.controller';
import { PaymentValidation } from './payment.validation';
import Auth from '../../middlewares/auth';
import { USER_ROLE } from '../../constant/userConstant';
import { writeOperationRateLimiter } from '../../middlewares/rateLimiter';
import { cache } from '../../middlewares/cache';

const router = express.Router();

router.post(
  '/',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(PaymentValidation.recordPaymentSchema),
  PaymentController.recordPayment,
);

router.get(
  '/',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  cache(60),
  validateRequest(PaymentValidation.getAllPaymentsSchema),
  PaymentController.getAllPayments,
);

router.get(
  '/due',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  cache(60),
  PaymentController.getDuePayments,
);

router.get(
  '/student/:studentId',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN, USER_ROLE.STUDENT),
  validateRequest(PaymentValidation.studentIdParamSchema),
  PaymentController.getStudentPayments,
);

router.patch(
  '/:id',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(PaymentValidation.updatePaymentSchema),
  PaymentController.updatePayment,
);

router.delete(
  '/:id',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  validateRequest(PaymentValidation.idParamSchema),
  PaymentController.deletePayment,
);

export const PaymentRoutes = router;