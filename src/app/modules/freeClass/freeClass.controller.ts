import httpStatus from 'http-status';
import { Request, Response } from 'express';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import config from '../../config';
import { authCookieName } from '../auth/auth.service';
import { FreeClassService } from './freeClass.service';

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: config.node_env === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 1000 * 60 * 60 * 24 * 365,
};

const signUpFreeStudent = catchAsync(async (req: Request, res: Response) => {
  const result = await FreeClassService.signUpFreeStudentToDB(req.body);
  res.cookie(authCookieName, result.refreshToken, REFRESH_COOKIE_OPTIONS);
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: 'Free signup successful',
    data: {
      user: result.user,
      student: result.student,
      accessToken: result.accessToken,
    },
  });
});

const freeLogin = catchAsync(async (req: Request, res: Response) => {
  const result = await FreeClassService.freeLoginToDB(req.body);
  res.cookie(authCookieName, result.tokens.refreshToken, REFRESH_COOKIE_OPTIONS);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Logged in successfully',
    data: {
      user: result.user,
      student: { isFreeAccount: true },
      accessToken: result.tokens.accessToken,
    },
  });
});

const getFreeContent = catchAsync(async (_req: Request, res: Response) => {
  const tree = await FreeClassService.getFreeContentFromDB();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Free class content fetched',
    data: tree,
  });
});

const getFreeTopicPlayback = catchAsync(async (req: Request, res: Response) => {
  const user = req.user as { userId: string; role: 'STUDENT' | 'ADMIN' | 'SUPER_ADMIN' };
  const topicId = Array.isArray(req.params.topicId)
    ? req.params.topicId[0]
    : req.params.topicId;

  // Admins (and super admins) preview the student experience without
  // a Student row and without polluting the FreeContentView ledger —
  // see getFreeTopicPlaybackForAdminToDB in the service for the
  // rationale. STUDENT callers go through the full path that resolves
  // their Student.id and upserts a view row.
  const result =
    user.role === 'STUDENT'
      ? await FreeClassService.getFreeTopicPlaybackForUserToDB(topicId, user.userId)
      : await FreeClassService.getFreeTopicPlaybackForAdminToDB(topicId);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Playback info fetched',
    data: result,
  });
});

export const FreeClassController = {
  signUpFreeStudent,
  freeLogin,
  getFreeContent,
  getFreeTopicPlayback,
};