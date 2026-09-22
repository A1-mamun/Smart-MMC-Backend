import { Request, Response } from 'express';
import httpStatus from 'http-status';
import { JwtPayload } from 'jsonwebtoken';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { AbsentWarningService } from './absentWarning.service';

const getAbsentPicker = catchAsync(async (req: Request, res: Response) => {
  const { date } = req.query as { date: string };
  const result = await AbsentWarningService.getAbsentPickerFromDB({ date });
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Absent recipients resolved',
    data: result,
  });
});

const runAbsentWarningNow = catchAsync(async (req: Request, res: Response) => {
  const user = req.user as JwtPayload;
  const result = await AbsentWarningService.runAbsentWarningJobFromDB(
    user.userId,
    user.role as 'SUPER_ADMIN' | 'ADMIN',
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Absent-warning job completed',
    data: result,
  });
});

export const AbsentWarningController = {
  getAbsentPicker,
  runAbsentWarningNow,
};
