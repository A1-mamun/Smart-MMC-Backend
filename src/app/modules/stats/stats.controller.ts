import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { StatsService } from './stats.service';

const getAdmissionComparison = catchAsync(async (req, res) => {
  const result = await StatsService.getAdmissionComparisonFromDB(
    req.query as Parameters<typeof StatsService.getAdmissionComparisonFromDB>[0],
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Admission comparison retrieved successfully',
    data: result,
  });
});

const getBatchWiseCourseStats = catchAsync(async (_req, res) => {
  const result = await StatsService.getBatchWiseCourseStatsFromDB();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Batch-wise stats retrieved successfully',
    data: result,
  });
});

const getCollectionTrend = catchAsync(async (_req, res) => {
  const result = await StatsService.getCollectionTrendFromDB();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Collection trend retrieved successfully',
    data: result,
  });
});

const getPaymentMethodBreakdown = catchAsync(async (_req, res) => {
  const result = await StatsService.getPaymentMethodBreakdownFromDB();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Payment method breakdown retrieved successfully',
    data: result,
  });
});

export const StatsController = {
  getAdmissionComparison,
  getBatchWiseCourseStats,
  getCollectionTrend,
  getPaymentMethodBreakdown,
};