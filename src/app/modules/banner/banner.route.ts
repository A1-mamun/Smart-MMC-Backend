import express from 'express';
import validateRequest from '../../middlewares/validateRequest';
import { BannerController } from './banner.controller';
import { BannerValidation } from './banner.validation';
import Auth from '../../middlewares/auth';
import { USER_ROLE } from '../../constant/userConstant';
import { writeOperationRateLimiter } from '../../middlewares/rateLimiter';
import { cache } from '../../middlewares/cache';

const router = express.Router();

/**
 * POST /banner/sign — admin requests signed upload params.
 * Auth: SUPER_ADMIN or ADMIN (both can manage banners).
 * The sign call is cheap (a sha1), so we still rate-limit it to
 * match the other write endpoints and prevent signature-flooding.
 */
router.post(
  '/sign',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(BannerValidation.signUploadSchema),
  BannerController.signUpload,
);

/**
 * GET /banner — public, NO auth. The landing page fetches this.
 * 60s cache: banners change rarely, and a 1-minute lag on the home
 * page is invisible. The POST /banner create + DELETE /banner/:id
 * both clear the cache via the service layer.
 */
router.get('/', cache(60), BannerController.getBanners);

/**
 * POST /banner — admin creates a Banner row after Cloudinary returns
 * the (secure_url, public_id). The browser flow is:
 *   1. POST /banner/sign → get signed params
 *   2. multipart POST to Cloudinary → get { secure_url, public_id }
 *   3. POST /banner { imageUrl, publicId, caption } → row inserted
 */
router.post(
  '/',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(BannerValidation.createBannerSchema),
  BannerController.createBanner,
);

/**
 * DELETE /banner/:id — admin deletes a banner. The service also
 * destroys the file on Cloudinary. Rate-limited like the other
 * write endpoints; a malicious DELETE on someone else's id is
 * blocked by UUID validation (the param is parsed as a uuid, and
 * the service looks up the row before calling Cloudinary).
 */
router.delete(
  '/:id',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(BannerValidation.bannerIdParamSchema),
  BannerController.deleteBanner,
);

export const BannerRoutes = router;
