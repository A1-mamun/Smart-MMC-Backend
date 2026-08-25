import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { StudentCourseService } from './studentCourse.service';
import { JwtPayload } from 'jsonwebtoken';

const enrollStudent = catchAsync(async (req, res) => {
  const result = await StudentCourseService.enrollStudentToDB(
    req.body,
    req.user as JwtPayload,
  );
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: 'Student enrolled successfully',
    data: result,
  });
});

const completeCourse = catchAsync(async (req, res) => {
  const result = await StudentCourseService.completeCourseFromDB(
    req.params.id,
    req.user as JwtPayload,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Course marked as completed',
    data: result,
  });
});

const getStudentCourses = catchAsync(async (req, res) => {
  const result = await StudentCourseService.getStudentCoursesFromDB(req.params.studentId);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Student courses retrieved successfully',
    data: result,
  });
});

const unenroll = catchAsync(async (req, res) => {
  await StudentCourseService.unenrollFromDB(
    req.params.id,
    req.user as JwtPayload,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Student unenrolled successfully',
    data: null,
  });
});

const getAllEnrollments = catchAsync(async (req, res) => {
  const { courseId, isCompleted } = req.query as {
    courseId?: string;
    isCompleted?: string;
  };
  const result = await StudentCourseService.getAllEnrollmentsFromDB({
    courseId,
    isCompleted: isCompleted === 'true' ? true : isCompleted === 'false' ? false : undefined,
  });
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Enrollments retrieved successfully',
    data: result,
  });
});

export const StudentCourseController = {
  enrollStudent,
  completeCourse,
  getStudentCourses,
  unenroll,
  getAllEnrollments,
};