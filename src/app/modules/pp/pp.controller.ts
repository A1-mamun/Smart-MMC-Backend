import httpStatus from 'http-status';
import { JwtPayload } from 'jsonwebtoken';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { PpService } from './pp.service';
import { TCreatePp, TRecordPpPayment } from './pp.validation';

/**
 * GET /pp — admin lists all live (non-deleted) PPs for the
 * management page. Returns the lightweight stats shape (base
 * fields + creator + counts). 60s cache at the route layer.
 */
const listPps = catchAsync(async (_req, res) => {
  const list = await PpService.listPpsFromDB();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'PPs fetched',
    data: list,
  });
});

/**
 * GET /pp/active — narrow (id, name) list used by the student
 * admission form's PP picker. Cached at the route layer; the
 * PP roster changes rarely so the cache miss is rare.
 *
 * Mounted under the same router so a single import covers both.
 */
const listActivePps = catchAsync(async (_req, res) => {
  const list = await PpService.listActivePpsFromDB();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Active PPs fetched',
    data: list,
  });
});

/**
 * GET /pp/:id — admin opens a PP detail. 404 if the row doesn't
 * exist or has been soft-deleted.
 */
const getPpDetail = catchAsync(async (req, res) => {
  const detail = await PpService.getPpDetailFromDB(req.params.id as string);
  if (!detail) {
    // Mirror the rest of the codebase's 404 shape so the
    // frontend error handler treats it the same way.
    sendResponse(res, {
      statusCode: httpStatus.NOT_FOUND,
      success: false,
      message: 'PP not found',
      data: null,
    });
    return;
  }
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'PP detail fetched',
    data: detail,
  });
});

/**
 * POST /pp — admin creates a new PP (just a name). Returns the
 * freshly-inserted row.
 */
const createPp = catchAsync(async (req, res) => {
  const created = await PpService.createPpInDB(
    req.body as TCreatePp,
    req.user as JwtPayload,
  );
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: 'PP added',
    data: created,
  });
});

/**
 * DELETE /pp/:id — admin soft-deletes a PP. 404 if it doesn't
 * exist or has already been deleted. The service clears the
 * /pp cache so the management page reflects the removal.
 */
const deletePp = catchAsync(async (req, res) => {
  const deleted = await PpService.deletePpFromDB(
    req.params.id as string,
    req.user as JwtPayload,
  );
  if (!deleted) {
    sendResponse(res, {
      statusCode: httpStatus.NOT_FOUND,
      success: false,
      message: 'PP not found',
      data: null,
    });
    return;
  }
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'PP deleted',
    data: deleted,
  });
});

/**
 * POST /pp/payment — admin records a payout to a PP. Returns
 * the inserted ledger row with `paidByUser` and `student`
 * hydrated so the frontend can show "by X" and the linked
 * student without a follow-up query.
 */
const recordPpPayment = catchAsync(async (req, res) => {
  const created = await PpService.recordPpPaymentInDB(
    req.body as TRecordPpPayment,
    req.user as JwtPayload,
  );
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: 'PP payment recorded',
    data: created,
  });
});

export const PpController = {
  listPps,
  listActivePps,
  getPpDetail,
  createPp,
  deletePp,
  recordPpPayment,
};