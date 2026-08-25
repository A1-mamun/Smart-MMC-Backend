import httpStatus from 'http-status';
import bcrypt from 'bcrypt';
import { JwtPayload } from 'jsonwebtoken';
import config from '../../config';
import prisma from '../../utils/prisma';
import AppError from '../../errors/AppError';
import {
  TLogin,
  TChangePassword,
  TForgotPassword,
  TResetPassword,
} from './auth.validation';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  generateResetToken,
} from './auth.utils';
import { TUserRole } from '../../interface/userRole';
import { sendEmail } from '../../utils/sendEmail';
import { clearCache } from '../../utils/clearCache';

export const authCookieName = 'refreshToken';

const signInUserToDB = async (payload: TLogin) => {
  const user = await prisma.user.findUnique({
    where: { studentId: payload.studentId },
  });

  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, 'No user found with this student ID');
  }
  if (user.isDeleted) {
    throw new AppError(httpStatus.FORBIDDEN, 'This account has been deleted');
  }
  if (user.status === 'BANNED') {
    throw new AppError(httpStatus.FORBIDDEN, 'This account has been banned');
  }

  const passwordMatch = await bcrypt.compare(payload.password, user.password);
  if (!passwordMatch) {
    throw new AppError(httpStatus.UNAUTHORIZED, 'Invalid credentials');
  }

  const tokenPayload = {
    userId: user.id,
    name: user.name,
    role: user.role as TUserRole,
    studentId: user.studentId,
  };

  const accessToken = generateAccessToken(tokenPayload);
  const refreshToken = generateRefreshToken(tokenPayload);

  const decoded = verifyRefreshToken(refreshToken);
  const expiresAt = new Date((decoded.exp as number) * 1000);

  await prisma.refreshToken.create({
    data: {
      token: refreshToken,
      userId: user.id,
      expiresAt,
    },
  });

  return {
    user: {
      id: user.id,
      studentId: user.studentId,
      name: user.name,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
    },
    accessToken,
    refreshToken,
  };
};

const refreshTokenToDB = async (
  tokenFromBody?: string,
  cookieToken?: string,
) => {
  const token = tokenFromBody || cookieToken;
  if (!token) throw new AppError(httpStatus.UNAUTHORIZED, 'No refresh token');

  let decoded;
  try {
    decoded = verifyRefreshToken(token);
  } catch {
    throw new AppError(httpStatus.UNAUTHORIZED, 'Invalid refresh token');
  }

  const stored = await prisma.refreshToken.findUnique({ where: { token } });
  if (!stored || stored.revoked || stored.expiresAt < new Date()) {
    throw new AppError(httpStatus.UNAUTHORIZED, 'Refresh token revoked or expired');
  }

  const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
  if (!user || user.isDeleted) {
    throw new AppError(httpStatus.UNAUTHORIZED, 'User not found');
  }

  const accessToken = generateAccessToken({
    userId: user.id,
    name: user.name,
    role: user.role as TUserRole,
    studentId: user.studentId,
  });

  return { accessToken };
};

const logoutFromDB = async (cookieToken?: string) => {
  if (cookieToken) {
    await prisma.refreshToken
      .update({
        where: { token: cookieToken },
        data: { revoked: true },
      })
      .catch(() => undefined);
  }
  return null;
};

const changePasswordToDB = async (
  userId: string,
  payload: TChangePassword,
) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found');

  const matched = await bcrypt.compare(payload.currentPassword, user.password);
  if (!matched) {
    throw new AppError(httpStatus.UNAUTHORIZED, 'Current password is incorrect');
  }

  const isSame = await bcrypt.compare(payload.newPassword, user.password);
  if (isSame) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'New password must be different from current password',
    );
  }

  const newHashed = await bcrypt.hash(
    payload.newPassword,
    Number(config.bcryptSaltRounds) || 12,
  );

  await prisma.user.update({
    where: { id: userId },
    data: {
      password: newHashed,
      passwordChangedAt: new Date(),
      passwordLevel: { increment: 1 },
      mustChangePassword: false,
    },
  });

  await prisma.refreshToken.updateMany({
    where: { userId, revoked: false },
    data: { revoked: true },
  });

  return { message: 'Password changed successfully' };
};

const forgotPasswordToDB = async (payload: TForgotPassword) => {
  const user = await prisma.user.findUnique({
    where: { studentId: payload.studentId },
  });
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'No user found');

  const token = generateResetToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  await prisma.passwordResetRequest.create({
    data: {
      userId: user.id,
      token,
      expiresAt,
    },
  });

  const resetLink = `${config.frontendUrls?.split(',')[0] || 'http://localhost:3000'}/reset-password?token=${token}`;

  await sendEmail({
    to: user.studentId,
    subject: 'Reset your Smart MMC password',
    html: `<p>Hello ${user.name},</p><p>Click the link below to reset your password (valid for 1 hour):</p><p><a href="${resetLink}">${resetLink}</a></p>`,
  }).catch(() => undefined);

  return { message: 'If an account exists, a reset link has been sent.' };
};

const resetPasswordToDB = async (payload: TResetPassword) => {
  const request = await prisma.passwordResetRequest.findUnique({
    where: { token: payload.token },
  });
  if (!request || request.used || request.expiresAt < new Date()) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Invalid or expired token');
  }

  const user = await prisma.user.findUnique({ where: { id: request.userId } });
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found');

  const newHashed = await bcrypt.hash(
    payload.newPassword,
    Number(config.bcryptSaltRounds) || 12,
  );

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        password: newHashed,
        passwordChangedAt: new Date(),
        passwordLevel: { increment: 1 },
        mustChangePassword: false,
      },
    }),
    prisma.passwordResetRequest.update({
      where: { id: request.id },
      data: { used: true },
    }),
  ]);

  await prisma.refreshToken.updateMany({
    where: { userId: user.id, revoked: false },
    data: { revoked: true },
  });

  return { message: 'Password reset successfully' };
};

const getMeFromDB = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      student: true,
    },
  });
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found');
  return user;
};

const getAllUsersFromDB = async (
  filters: { searchTerm?: string; role?: TUserRole },
  options: { page?: number; limit?: number; sortBy?: string; sortOrder?: 'asc' | 'desc' },
) => {
  const page = Number(options.page) || 1;
  const limit = Number(options.limit) || 10;
  const skip = (page - 1) * limit;
  const sortBy = options.sortBy || 'createdAt';
  const sortOrder = options.sortOrder || 'desc';

  const where: Record<string, unknown> = { isDeleted: false };
  if (filters.role) where.role = filters.role;
  if (filters.searchTerm) {
    where.OR = [
      { name: { contains: filters.searchTerm, mode: 'insensitive' } },
      { studentId: { contains: filters.searchTerm, mode: 'insensitive' } },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take: limit,
      orderBy: { [sortBy]: sortOrder },
      select: {
        id: true,
        studentId: true,
        name: true,
        nickname: true,
        role: true,
        status: true,
        mustChangePassword: true,
        createdAt: true,
      },
    }),
    prisma.user.count({ where }),
  ]);

  await clearCache('cache:/api/v1/user*').catch(() => undefined);

  return {
    data,
    meta: { page, limit, total },
  };
};

const getUserByIdFromDB = async (id: string) => {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found');
  return user;
};

const updateUserInDB = async (
  id: string,
  payload: { name?: string; studentId?: string; password?: string },
) => {
  const data: Record<string, unknown> = {};
  if (payload.name) data.name = payload.name;
  if (payload.studentId) data.studentId = payload.studentId;
  if (payload.password) {
    data.password = await bcrypt.hash(
      payload.password,
      Number(config.bcryptSaltRounds) || 12,
    );
    data.passwordChangedAt = new Date();
    data.passwordLevel = { increment: 1 };
  }
  return prisma.user.update({ where: { id }, data });
};

const deleteUserFromDB = async (id: string, deletedBy: string) => {
  return prisma.user.update({
    where: { id },
    data: {
      isDeleted: true,
      deletedAt: new Date(),
      deletedBy,
    },
  });
};

const createUserToDB = async (payload: {
  studentId: string;
  name: string;
  password: string;
  role: 'SUPER_ADMIN' | 'ADMIN' | 'STUDENT';
}) => {
  const hashed = await bcrypt.hash(
    payload.password,
    Number(config.bcryptSaltRounds) || 12,
  );
  return prisma.user.create({
    data: {
      studentId: payload.studentId,
      name: payload.name,
      password: hashed,
      role: payload.role,
      mustChangePassword: false,
      passwordLevel: 1,
      passwordChangedAt: new Date(),
    },
  });
};

export const AuthService = {
  signInUserToDB,
  refreshTokenToDB,
  logoutFromDB,
  changePasswordToDB,
  forgotPasswordToDB,
  resetPasswordToDB,
  getMeFromDB,
  createUserToDB,
  getAllUsersFromDB,
  getUserByIdFromDB,
  updateUserInDB,
  deleteUserFromDB,
};

export type TAuthPayload = JwtPayload;