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
  const userId = (req.user as { userId: string }).userId;
  const topicId = Array.isArray(req.params.topicId)
    ? req.params.topicId[0]
    : req.params.topicId;
  const result = await FreeClassService.getFreeTopicPlaybackForUserToDB(
    topicId,
    userId,
  );
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