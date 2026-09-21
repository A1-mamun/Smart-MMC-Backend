import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import pick from '../../utils/pick';
import { StudentService } from './student.service';
import { studentFilterableFields } from './student.constant';
import { paginationFields } from '../../constant/pagination';
import { JwtPayload } from 'jsonwebtoken';

const admitStudent = catchAsync(async (req, res) => {
  const result = await StudentService.admitStudentToDB(req.body, req.user as JwtPayload);
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    // Different message depending on whether we created a new profile
    // or added a course to an existing one — the admit form surfaces
    // the appropriate success copy from this string.
    message: result.alreadyEnrolled
      ? `Existing student added to the new course (${result.studentCourseId})`
      : 'Student admitted successfully',
    data: {
      student: result.student,
      credentials: {
        studentId: result.studentId,
        // null when the profile already existed — no new login creds.
        initialPassword: result.initialPassword,
        studentCourseId: result.studentCourseId,
        alreadyEnrolled: result.alreadyEnrolled,
      },
    },
  });
});

const enrollExistingStudent = catchAsync(async (req, res) => {
  const result = await StudentService.enrollExistingStudentToDB(
    req.body,
    req.user as JwtPayload,
  );
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    // Same success copy the admit endpoint uses when it detects an
    // existing student — the credentials card on the frontend renders
    // identically regardless of which endpoint produced the response.
    message: `Existing student added to the new course (${result.studentCourseId})`,
    data: {
      student: result.student,
      credentials: {
        studentId: result.studentId,
        // null when reusing the profile — no new login creds minted.
        initialPassword: result.initialPassword,
        studentCourseId: result.studentCourseId,
        alreadyEnrolled: result.alreadyEnrolled,
      },
    },
  });
});

const getAllStudents = catchAsync(async (req, res) => {
  const filters = pick(req.query as Record<string, unknown>, studentFilterableFields);
  const paginationOptions = pick(req.query as Record<string, unknown>, paginationFields);
  const result = await StudentService.getAllStudentsFromDB(
    filters as Parameters<typeof StudentService.getAllStudentsFromDB>[0],
    paginationOptions as Parameters<typeof StudentService.getAllStudentsFromDB>[1],
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Students retrieved successfully',
    meta: result.meta,
    data: result.data,
  });
});

const getStudentById = catchAsync(async (req, res) => {
  const result = await StudentService.getStudentByIdFromDB(req.params.id as string);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Student retrieved successfully',
    data: result,
  });
});

const updateStudent = catchAsync(async (req, res) => {
  const result = await StudentService.updateStudentInDB(
    req.params.id as string,
    req.body,
    req.user as JwtPayload,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Student updated successfully',
    data: result,
  });
});

const deleteStudent = catchAsync(async (req, res) => {
  await StudentService.deleteStudentFromDB(
    req.params.id as string,
    req.user as JwtPayload,
    req.body?.hard || false,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Student deleted successfully',
    data: null,
  });
});

const getMyProfile = catchAsync(async (req, res) => {
  const userId = (req.user as JwtPayload).userId;
  const result = await StudentService.getMyProfileFromDB(userId);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Profile retrieved successfully',
    data: result,
  });
});

export const StudentController = {
  admitStudent,
  enrollExistingStudent,
  getAllStudents,
  getStudentById,
  updateStudent,
  deleteStudent,
  getMyProfile,
};
