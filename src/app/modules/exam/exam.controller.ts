import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import pick from '../../utils/pick';
import { ExamService } from './exam.service';
import { examFilterableFields } from './exam.constant';
import { paginationFields } from '../../constant/pagination';
import { JwtPayload } from 'jsonwebtoken';

const createExam = catchAsync(async (req, res) => {
  const exam = await ExamService.createExamToDB(req.body, req.user as JwtPayload);
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: 'Exam created successfully',
    data: exam,
  });
});

const updateExam = catchAsync(async (req, res) => {
  const exam = await ExamService.updateExamToDB(
    req.params.id as string,
    req.body,
    req.user as JwtPayload,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Exam updated successfully',
    data: exam,
  });
});

const setPublish = catchAsync(async (req, res) => {
  // console.log('setPublish called with body:', req.body);
  const exam = await ExamService.setExamPublishToDB(
    req.params.id as string,
    req.body,
    req.user as JwtPayload,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: req.body.isResultPublished ? 'Results published successfully' : 'Results unpublished',
    data: exam,
  });
});

const upsertRoster = catchAsync(async (req, res) => {
  const result = await ExamService.upsertRosterToDB(
    req.params.id as string,
    req.body,
    req.user as JwtPayload,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Roster updated successfully',
    data: result,
  });
});

const setAttendance = catchAsync(async (req, res) => {
  const result = await ExamService.setAttendanceToDB(
    req.params.id as string,
    req.body,
    req.user as JwtPayload,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: req.body.isAbsent ? 'Marked absent' : 'Marked present',
    data: result,
  });
});

const bulkAttendanceByStudentId = catchAsync(async (req, res) => {
  const result = await ExamService.bulkAttendanceByStudentIdToDB(
    req.params.id as string,
    req.body,
    req.user as JwtPayload,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Attendance updated',
    data: result,
  });
});

const upsertResult = catchAsync(async (req, res) => {
  const result = await ExamService.upsertResultToDB(
    req.params.id as string,
    req.body,
    req.user as JwtPayload,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Result saved',
    data: result,
  });
});

const bulkResults = catchAsync(async (req, res) => {
  const result = await ExamService.bulkResultsToDB(
    req.params.id as string,
    req.body,
    req.user as JwtPayload,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: `Bulk save: ${result.succeeded.length} succeeded, ${result.failed.length} failed`,
    data: result,
  });
});

const getAllExams = catchAsync(async (req, res) => {
  const filters = pick(req.query as Record<string, unknown>, examFilterableFields);
  const paginationOptions = pick(req.query as Record<string, unknown>, paginationFields);
  const result = await ExamService.getAllExamsFromDB(
    filters as Parameters<typeof ExamService.getAllExamsFromDB>[0],
    paginationOptions as Parameters<typeof ExamService.getAllExamsFromDB>[1],
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Exams retrieved successfully',
    meta: result.meta,
    data: result.data,
  });
});

const getExamById = catchAsync(async (req, res) => {
  const result = await ExamService.getExamByIdToDB(req.params.id as string);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Exam retrieved successfully',
    data: result,
  });
});

const getMyResults = catchAsync(async (req, res) => {
  const userId = (req.user as JwtPayload).userId;
  const result = await ExamService.getMyResultsFromDB(
    userId,
    req.query as Parameters<typeof ExamService.getMyResultsFromDB>[1],
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Results retrieved successfully',
    meta: result.meta,
    data: result.data,
  });
});

export const ExamController = {
  createExam,
  updateExam,
  setPublish,
  upsertRoster,
  setAttendance,
  bulkAttendanceByStudentId,
  upsertResult,
  bulkResults,
  getAllExams,
  getExamById,
  getMyResults,
};
