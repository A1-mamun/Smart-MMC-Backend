import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { SettingsService } from './settings.service';
import { AbsentWarningService } from '../absentWarning/absentWarning.service';
import { ExamAbsenceWarningService } from '../examAbsenceWarning/examAbsenceWarning.service';

const getConfig = catchAsync(async (_req, res) => {
  const config = await SettingsService.getConfigFromDB();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Settings fetched',
    data: config,
  });
});

const upsertConfig = catchAsync(async (req, res) => {
  const config = await SettingsService.upsertConfigInDB(req.body, req.user as never);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Settings updated',
    data: config,
  });
});

/**
 * Synchronous ad-hoc run of the absent-warning job. The button on
 * /dashboard/settings fires this; the scheduler at server start fires
 * the same job on its cron tick. The job's idempotency is enforced by
 * the `WeeklyAbsentWarning` dedupe table, so two runs in quick
 * succession can't double-warn the same student in the same ISO week.
 */
const runAbsentWarningNow = catchAsync(async (req, res) => {
  const result = await AbsentWarningService.runAbsentWarningJobFromDB(
    (req.user as { userId: string }).userId,
    (req.user as { role: 'SUPER_ADMIN' | 'ADMIN' }).role,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: `Absent-warning job finished (${result.sent} sent, ${result.skipped} skipped, ${result.total} matched)`,
    data: result,
  });
});

/**
 * Synchronous ad-hoc run of the exam-absence job. Mirrors
 * `runAbsentWarningNow` exactly — same response shape, same dedupe
 * contract (the (examId, studentId) unique index on
 * ExamAbsenceWarning prevents re-fires). The button is rendered
 * alongside the absent-warning one on the settings page.
 */
const runExamAbsenceWarningNow = catchAsync(async (req, res) => {
  const result = await ExamAbsenceWarningService.runJobFromDB(
    (req.user as { userId: string }).userId,
    (req.user as { role: 'SUPER_ADMIN' | 'ADMIN' }).role,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: `Exam-absence job finished (${result.sent} sent, ${result.skipped} skipped, ${result.total} matched)`,
    data: result,
  });
});

export const SettingsController = {
  getConfig,
  upsertConfig,
  runAbsentWarningNow,
  runExamAbsenceWarningNow,
};
