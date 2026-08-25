import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { CourseService } from './course.service';
import pick from '../../utils/pick';
import { paginationFields } from '../../constant/pagination';

const createCourse = catchAsync(async (req, res) => {
  const result = await CourseService.createCourseToDB(req.body);
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: 'Course created successfully',
    data: result,
  });
});

const getAllCourses = catchAsync(async (req, res) => {
  const filters = pick(req.query as Record<string, unknown>, [
    'isActive',
    'searchTerm',
  ]);
  const paginationOptions = pick(
    req.query as Record<string, unknown>,
    paginationFields,
  );
  // Express query strings are always strings — coerce isActive manually.
  if (filters.isActive !== undefined) {
    if (filters.isActive === 'true') filters.isActive = true;
    else if (filters.isActive === 'false') filters.isActive = false;
  }
  const result = await CourseService.getAllCoursesFromDB(
    { ...filters, ...paginationOptions } as Parameters<typeof CourseService.getAllCoursesFromDB>[0],
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Courses retrieved successfully',
    meta: result.meta,
    data: result.data,
  });
});

const getCourseById = catchAsync(async (req, res) => {
  const result = await CourseService.getCourseByIdFromDB(req.params.id);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Course retrieved successfully',
    data: result,
  });
});

const updateCourse = catchAsync(async (req, res) => {
  const result = await CourseService.updateCourseInDB(req.params.id, req.body);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Course updated successfully',
    data: result,
  });
});

const deleteCourse = catchAsync(async (req, res) => {
  await CourseService.deleteCourseFromDB(req.params.id);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Course deleted successfully',
    data: null,
  });
});

const toggleActive = catchAsync(async (req, res) => {
  const result = await CourseService.toggleCourseActiveToDB(
    req.params.id,
    req.body.isActive,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: `Course ${result.isActive ? 'activated' : 'deactivated'} successfully`,
    data: result,
  });
});

export const CourseController = {
  createCourse,
  getAllCourses,
  getCourseById,
  updateCourse,
  deleteCourse,
  toggleActive,
};