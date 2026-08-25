import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { ActivityLogService } from './activityLog.service';
import pick from '../../utils/pick';
import { paginationFields } from '../../constant/pagination';

const getAllActivities = catchAsync(async (req, res) => {
  const filters = pick(req.query as Record<string, unknown>, [
    'actorId',
    'action',
    'entityType',
    'startDate',
    'endDate',
  ]);
  const paginationOptions = pick(
    req.query as Record<string, unknown>,
    paginationFields,
  );
  const result = await ActivityLogService.getAllActivitiesFromDB(
    { ...filters, ...paginationOptions } as Parameters<typeof ActivityLogService.getAllActivitiesFromDB>[0],
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Activities retrieved successfully',
    meta: result.meta,
    data: result.data,
  });
});

const getRecent = catchAsync(async (req, res) => {
  const limit = Number(req.query.limit) || 10;
  const result = await ActivityLogService.getRecentActivitiesFromDB(limit);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Recent activities retrieved successfully',
    data: result,
  });
});

export const ActivityLogController = {
  getAllActivities,
  getRecent,
};