import httpStatus from 'http-status';
import { Request, Response } from 'express';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';

import { AuthService, authCookieName } from './auth.service';
import config from '../../config';

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: config.node_env === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 1000 * 60 * 60 * 24 * 365,
};

const signInUser = catchAsync(async (req, res) => {
  const result = await AuthService.signInUserToDB(req.body);
  res.cookie(authCookieName, result.refreshToken, REFRESH_COOKIE_OPTIONS);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Logged in successfully',
    data: {
      user: result.user,
      accessToken: result.accessToken,
    },
  });
});

const refreshToken = catchAsync(async (req, res) => {
  const cookieToken = (req.cookies as Record<string, string>)?.[authCookieName];
  const result = await AuthService.refreshTokenToDB(req.body?.refreshToken, cookieToken);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Access token refreshed',
    data: result,
  });
});

const logout = catchAsync(async (req, res) => {
  const cookieToken = (req.cookies as Record<string, string>)?.[authCookieName];
  await AuthService.logoutFromDB(cookieToken);
  res.clearCookie(authCookieName, { path: '/' });
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Logged out successfully',
    data: null,
  });
});

const changePassword = catchAsync(async (req: Request, res: Response) => {
  const userId = (req.user as { userId: string }).userId;
  const result = await AuthService.changePasswordToDB(userId, req.body);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: result.message,
    data: null,
  });
});

const forgotPassword = catchAsync(async (req, res) => {
  const result = await AuthService.forgotPasswordToDB(req.body);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: result.message,
    data: null,
  });
});

const resetPassword = catchAsync(async (req, res) => {
  const result = await AuthService.resetPasswordToDB(req.body);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: result.message,
    data: null,
  });
});

const getMe = catchAsync(async (req: Request, res: Response) => {
  const userId = (req.user as { userId: string }).userId;
  const user = await AuthService.getMeFromDB(userId);
  const { password, ...rest } = user;
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'User retrieved successfully',
    data: rest,
  });
});

export const AuthController = {
  signInUser,
  refreshToken,
  logout,
  changePassword,
  forgotPassword,
  resetPassword,
  getMe,
};
