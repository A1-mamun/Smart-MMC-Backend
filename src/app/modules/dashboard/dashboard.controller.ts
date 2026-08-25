import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { DashboardService } from './dashboard.service';
import { JwtPayload } from 'jsonwebtoken';

const getAdminDashboard = catchAsync(async (_req, res) => {
  const result = await DashboardService.getAdminDashboardDataFromDB();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Admin dashboard data retrieved successfully',
    data: result,
  });
});

const getStudentDashboard = catchAsync(async (req, res) => {
  const userId = (req.user as JwtPayload).userId;
  const result = await DashboardService.getStudentDashboardDataFromDB(userId);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Student dashboard data retrieved successfully',
    data: result,
  });
});

export const DashboardController = {
  getAdminDashboard,
  getStudentDashboard,
};