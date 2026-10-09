import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { AttendanceService } from './attendance.service';
import pick from '../../utils/pick';
import { paginationFields } from '../../constant/pagination';
import { JwtPayload } from 'jsonwebtoken';
import { TGetStudentAttendance } from './attendance.validation';

const checkIn = catchAsync(async (req, res) => {
  const result = await AttendanceService.checkInStudentToDB(req.body);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: result.message,
    data: result,
  });
});

const manualCheckIn = catchAsync(async (req, res) => {
  const result = await AttendanceService.manualCheckInToDB(req.body, req.user as JwtPayload);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: result.message,
    data: result,
  });
});

const getToday = catchAsync(async (req, res) => {
  const filters = pick(req.query as Record<string, unknown>, [
    'courseId',
    'batchTime',
    'hscBatch',
  ]);
  const paginationOptions = pick(req.query as Record<string, unknown>, paginationFields);
  const result = await AttendanceService.getTodayAttendanceFromDB({
    ...filters,
    ...paginationOptions,
  } as Parameters<typeof AttendanceService.getTodayAttendanceFromDB>[0]);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Today's attendance retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

const getStudentAttendance = catchAsync(async (req, res) => {
  const result = await AttendanceService.getStudentAttendanceFromDB(
    req as unknown as TGetStudentAttendance,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Attendance retrieved successfully',
    meta: result.meta,
    data: result.data,
    extraData: result.summary,
  });
});

const getStats = catchAsync(async (_req, res) => {
  const result = await AttendanceService.getAttendanceStatsFromDB();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Attendance stats retrieved successfully',
    data: result,
  });
});

/**
 * GET /attendance/current-batch — powers the automatic-attendance
 * kiosk view. Returns the batch (course + day + time) that's
 * happening right now, or the next upcoming one if no batch is
 * in progress, or `{ kind: 'none' }` if nothing is scheduled
 * today. The kiosk polls this every minute (and after every
 * successful scan) to auto-rotate the displayed batch.
 *
 * Unauthenticated on purpose — the kiosk view is opened in a
 * separate window without the admin's JWT. The same `DEVICE_SECRET`
 * gate used by `/attendance/check-in` applies here so only the
 * shared-kiosk device can ask.
 */
const getCurrentBatch = catchAsync(async (req, res) => {
  const result = await AttendanceService.getCurrentBatchFromDB();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Current batch retrieved successfully',
    data: result,
  });
});

const deleteAttendance = catchAsync(async (req, res) => {
  await AttendanceService.deleteAttendanceFromDB(req.params.id as string, req.user as JwtPayload);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Attendance deleted successfully',
    data: null,
  });
});

export const AttendanceController = {
  checkIn,
  manualCheckIn,
  getToday,
  getStudentAttendance,
  getStats,
  getCurrentBatch,
  deleteAttendance,
};
