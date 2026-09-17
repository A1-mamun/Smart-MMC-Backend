import httpStatus from 'http-status';
import { JwtPayload } from 'jsonwebtoken';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { SmsService } from './sms.service';
import pick from '../../utils/pick';

const sendSms = catchAsync(async (req, res) => {
  const result = await SmsService.sendSmsToDB(req.body, req.user as JwtPayload);
  sendResponse(res, {
    statusCode: result.result.ok ? httpStatus.OK : httpStatus.BAD_GATEWAY,
    success: result.result.ok,
    message: result.result.message,
    data: {
      log: result.log,
      skipped: result.skipped,
      upstreamCode: result.result.upstreamCode,
    },
  });
});

const getBalance = catchAsync(async (_req, res) => {
  const result = await SmsService.getBalanceFromDB();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Balance fetched successfully',
    data: result,
  });
});

const getMyLogs = catchAsync(async (req, res) => {
  const query = pick(req.query as Record<string, unknown>, ['limit']);
  const result = await SmsService.getMySmsLogsFromDB(
    (req.user as JwtPayload).userId,
    { limit: typeof query.limit === 'string' ? Number(query.limit) : undefined },
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'SMS logs retrieved successfully',
    data: result.data,
    meta: { ...result.meta, limit: result.data.length, page: 1 },
  });
});

export const SmsController = {
  sendSms,
  getBalance,
  getMyLogs,
};
