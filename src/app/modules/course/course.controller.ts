import httpStatus from 'http-status';
import { JwtPayload } from 'jsonwebtoken';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { CourseService } from './course.service';
import pick from '../../utils/pick';
import { paginationFields } from '../../constant/pagination';
import { TSetSlotWindowOverride } from './course.validation';

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
  const filters = pick(req.query as Record<string, unknown>, ['isActive', 'status', 'searchTerm']);
  const paginationOptions = pick(req.query as Record<string, unknown>, paginationFields);
  // Express query strings are always strings — coerce isActive manually.
  if (filters.isActive !== undefined) {
    if (filters.isActive === 'true') filters.isActive = true;
    else if (filters.isActive === 'false') filters.isActive = false;
  }
  const result = await CourseService.getAllCoursesFromDB({
    ...filters,
    ...paginationOptions,
  } as Parameters<typeof CourseService.getAllCoursesFromDB>[0]);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Courses retrieved successfully',
    meta: result.meta,
    data: result.data,
  });
});

const getCourseById = catchAsync(async (req, res) => {
  const result = await CourseService.getCourseByIdFromDB(req.params.id as string);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Course retrieved successfully',
    data: result,
  });
});

const getCourseSeats = catchAsync(async (req, res) => {
  const result = await CourseService.getCourseSeatsFromDB(req.params.id as string);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Course seat counts retrieved successfully',
    data: result,
  });
});

const updateCourse = catchAsync(async (req, res) => {
  const result = await CourseService.updateCourseInDB(req.params.id as string, req.body);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Course updated successfully',
    data: result,
  });
});

const deleteCourse = catchAsync(async (req, res) => {
  await CourseService.deleteCourseFromDB(req.params.id as string);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Course deleted successfully',
    data: null,
  });
});

const toggleActive = catchAsync(async (req, res) => {
  const result = await CourseService.toggleCourseActiveToDB(
    req.params.id as string,
    req.body.isActive,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: `Course ${result.isActive ? 'activated' : 'deactivated'} successfully`,
    data: result,
  });
});

const setStatus = catchAsync(async (req, res) => {
  // Single-click status transition from the Courses page. The service
  // keeps `isAllowAdmitAnotherCourse` in sync with the new status so
  // an admin can't accidentally let a still-admitting course pretend
  // to be graduated (or vice-versa).
  const result = await CourseService.setCourseStatusToDB(
    req.params.id as string,
    req.body,
    req.user,
  );
  const stage = result.status;
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message:
      stage === 'COMPLETE'
        ? `Course "${result.name}" marked as completed. Students can now enroll in another course.`
        : stage === 'ONGOING'
        ? `Course "${result.name}" is now ongoing. New admits are gated behind each student's existing enrollment.`
        : `Course "${result.name}" is back in admission. New enrollments are open.`,
    data: result,
  });
});

const toggleAdmitAnotherCourse = catchAsync(async (req, res) => {
  // Independent override for the enrollment gate. The Courses page
  // surfaces this as a single-click toggle button next to the status
  // segmented control so admins can flip the gate without touching
  // the status enum. See `toggleCourseAdmitAnotherCourseToDB` for
  // the override-vs-status interaction rules.
  const result = await CourseService.toggleCourseAdmitAnotherCourseToDB(
    req.params.id as string,
    req.body.isAllowAdmitAnotherCourse,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: result.isAllowAdmitAnotherCourse
      ? `Course "${result.name}" now allows students to admit into another course.`
      : `Course "${result.name}" now gates re-admissions behind each student's existing enrollment.`,
    data: result,
  });
});

/**
 * Per-slot "Take attendance" toggle. The Courses page renders a
 * small switch next to every times[] entry; flipping one ON
 * auto-disables every other slot in the same BatchDay so the
 * kiosk can never serve two slots concurrently. See
 * `toggleBatchSlotToDB` for the in-memory sibling-disabling
 * logic.
 */
const toggleBatchSlot = catchAsync(async (req, res) => {
  const result = await CourseService.toggleBatchSlotToDB(
    req.params.id as string,
    req.body,
    req.user as JwtPayload,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: req.body.enabled
      ? `Attendance enabled for ${result.name} · ${result.times[req.body.slotIndex]}.`
      : `Attendance disabled for ${result.name} · ${result.times[req.body.slotIndex]}.`,
    data: result,
  });
});

/**
 * Per-slot "check-in window override" toggle. The admin uses
 * this when they want the kiosk to accept scans for a slot
 * outside the default 5-minute window — open the window
 * early (e.g. admit an early arrival) or keep it open past
 * the 5-min mark (e.g. when the class is delayed). The
 * Courses page surfaces this as a Switch next to the
 * existing "Take attendance" toggle.
 */
const setSlotWindowOverride = catchAsync(async (req, res) => {
  const result = await CourseService.setSlotWindowOverrideToDB(
    req.params.id as string,
    req.body as TSetSlotWindowOverride['body'],
    req.user as JwtPayload,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: req.body.open
      ? `Check-in window override OPEN for ${result.name} · ${result.times[req.body.slotIndex]}. Scans accepted regardless of the wall clock.`
      : `Check-in window override CLOSED for ${result.name} · ${result.times[req.body.slotIndex]}. Default 5-min window applies.`,
    data: result,
  });
});

export const CourseController = {
  createCourse,
  getAllCourses,
  getCourseById,
  getCourseSeats,
  updateCourse,
  deleteCourse,
  toggleActive,
  setStatus,
  toggleAdmitAnotherCourse,
  toggleBatchSlot,
  setSlotWindowOverride,
};
