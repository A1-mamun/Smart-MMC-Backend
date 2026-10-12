import express from 'express';
import validateRequest from '../../middlewares/validateRequest';
import { PpController } from './pp.controller';
import { PpValidation } from './pp.validation';
import Auth from '../../middlewares/auth';
import { USER_ROLE } from '../../constant/userConstant';
import { writeOperationRateLimiter } from '../../middlewares/rateLimiter';
import { cache } from '../../middlewares/cache';

const router = express.Router();

/**
 * POST /pp — admin creates a PP (just a name). The
 * `writeOperationRateLimiter` matches the other write endpoints
 * in the codebase so a runaway script can't flood the DB with
 * empty PP rows.
 */
router.post(
  '/',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(PpValidation.createPpSchema),
  PpController.createPp,
);

/**
 * GET /pp/active — narrow (id, name) list used by the student
 * admit form's PP select. Cached 60s: the PP roster changes
 * rarely, and a 1-minute lag on a brand-new PP being attachable
 * to a student is acceptable. The create / delete handlers clear
 * the cache via the service layer.
 */
router.get(
  '/active',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  cache(60),
  PpController.listActivePps,
);

/**
 * GET /pp — admin lists all PPs with `_count` for the
 * management page. 60s cache (read-heavy, write-rare).
 */
router.get(
  '/',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  cache(60),
  PpController.listPps,
);

/**
 * GET /pp/:id — admin opens a PP detail. 60s cache: the detail
 * page is opened infrequently per PP, so the cache mostly
 * serves repeat opens in a single session.
 */
router.get(
  '/:id',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  cache(60),
  validateRequest(PpValidation.ppIdParamSchema),
  PpController.getPpDetail,
);

/**
 * DELETE /pp/:id — admin soft-deletes a PP. Rate-limited like
 * the other write endpoints. UUID validation in the param
 * schema blocks a malicious non-UUID id from reaching the
 * service.
 */
router.delete(
  '/:id',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(PpValidation.ppIdParamSchema),
  PpController.deletePp,
);

/**
 * POST /pp/payment — admin records a payout to a PP. This is
 * a write op (rate-limited) and lives under the PP namespace
 * (not /payment) because the money flow is the *opposite*
 * direction of the existing /payment endpoints — those track
 * student → centre, this tracks centre → PP. Same auth scope
 * (admin) as the rest of the PP routes.
 */
router.post(
  '/payment',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(PpValidation.recordPpPaymentSchema),
  PpController.recordPpPayment,
);

export const PpRoutes = router;