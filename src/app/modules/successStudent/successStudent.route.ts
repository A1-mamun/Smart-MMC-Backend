import express from 'express';
import validateRequest from '../../middlewares/validateRequest';
import { SuccessStudentController } from './successStudent.controller';
import { SuccessStudentValidation } from './successStudent.validation';
import Auth from '../../middlewares/auth';
import { USER_ROLE } from '../../constant/userConstant';
import { writeOperationRateLimiter } from '../../middlewares/rateLimiter';
import { cache } from '../../middlewares/cache';

const router = express.Router();

/**
 * POST /success-student/sign — admin requests signed upload params.
 * Auth: SUPER_ADMIN or ADMIN (both can manage success students).
 * The sign call is cheap (a sha1), so we still rate-limit it to
 * match the other write endpoints and prevent signature-flooding.
 */
router.post(
  '/sign',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(SuccessStudentValidation.signUploadSchema),
  SuccessStudentController.signUpload,
);

/**
 * GET /success-student — public, NO auth. The landing page fetches
 * this. 60s cache: success students change rarely, and a 1-minute
 * lag on the home page is invisible. The POST /success-student
 * create + DELETE /success-student/:id both clear the cache via the
 * service layer.
 */
router.get('/', cache(60), SuccessStudentController.getSuccessStudents);

/**
 * POST /success-student — admin creates a SuccessStudent row after
 * Cloudinary returns the (secure_url, public_id). The browser flow
 * is the same as for banners:
 *   1. POST /success-student/sign → get signed params
 *   2. multipart POST to Cloudinary → get { secure_url, public_id }
 *   3. POST /success-student { name, institute, batch, imageUrl,
 *      publicId } → row inserted
 */
router.post(
  '/',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(SuccessStudentValidation.createSuccessStudentSchema),
  SuccessStudentController.createSuccessStudent,
);

/**
 * DELETE /success-student/:id — admin deletes a success student.
 * The service also destroys the file on Cloudinary. Rate-limited
 * like the other write endpoints; a malicious DELETE on someone
 * else's id is blocked by UUID validation (the param is parsed as
 * a uuid, and the service looks up the row before calling
 * Cloudinary).
 */
router.delete(
  '/:id',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(SuccessStudentValidation.successStudentIdParamSchema),
  SuccessStudentController.deleteSuccessStudent,
);

export const SuccessStudentRoutes = router;
