import express from 'express';
import validateRequest from '../../middlewares/validateRequest';
import { ExamController } from './exam.controller';
import { ExamValidation } from './exam.validation';
import Auth from '../../middlewares/auth';
import { USER_ROLE } from '../../constant/userConstant';
import { writeOperationRateLimiter } from '../../middlewares/rateLimiter';

const router = express.Router();

// IMPORTANT: `/me/*` routes must come BEFORE `/:id` so Express doesn't match
// "me" / "upcoming" as a UUID parameter.
router.get(
  '/me/results',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN, USER_ROLE.STUDENT),
  validateRequest(ExamValidation.getMyResultsSchema),
  ExamController.getMyResults,
);
router.get(
  '/me/upcoming',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN, USER_ROLE.STUDENT),
  validateRequest(ExamValidation.getMyUpcomingExamsSchema),
  ExamController.getMyUpcomingExams,
);

// List + create
router.get(
  '/',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  validateRequest(ExamValidation.listExamsSchema),
  ExamController.getAllExams,
);
router.post(
  '/',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(ExamValidation.createExamSchema),
  ExamController.createExam,
);

// Detail + update + delete (delete not exposed in UI; route kept for ops)
router.get(
  '/:id',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  validateRequest(ExamValidation.idParamSchema),
  ExamController.getExamById,
);
router.patch(
  '/:id',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(ExamValidation.updateExamSchema),
  ExamController.updateExam,
);

// Publish toggle
router.patch(
  '/:id/publish',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(ExamValidation.setPublishSchema),
  ExamController.setPublish,
);

// Roster management
router.post(
  '/:id/roster',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(ExamValidation.upsertRosterSchema),
  ExamController.upsertRoster,
);

// Attendance
router.patch(
  '/:id/attendance',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(ExamValidation.setAttendanceSchema),
  ExamController.setAttendance,
);
router.post(
  '/:id/attendance/bulk',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(ExamValidation.bulkAttendanceByStudentIdSchema),
  ExamController.bulkAttendanceByStudentId,
);

// Results
router.put(
  '/:id/results',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(ExamValidation.upsertResultSchema),
  ExamController.upsertResult,
);
router.put(
  '/:id/results/bulk',
  Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN),
  writeOperationRateLimiter,
  validateRequest(ExamValidation.bulkResultsSchema),
  ExamController.bulkResults,
);

export const ExamRoutes = router;
