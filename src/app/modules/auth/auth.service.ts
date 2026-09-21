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
  // Mobile is the new canonical login handle for students; admins (no
  // mobile on file) and legacy students who never migrated still log
  // in with their `studentId`. Try mobile first, then studentId. Both
  // branches need to succeed before we treat the lookup as "not
  // found".
  const identifier = (payload.mobile ?? payload.studentId ?? '').trim();
  if (!identifier) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Mobile or student ID is required');
  }

  // Prisma's `findUnique` only accepts fields declared as `@unique` on the
  // model. The mobile uniqueness lives in a partial unique index
  // (`WHERE mobile IS NOT NULL AND isDeleted = false`), so we have to
  // use `findFirst` and re-apply the same filter the index encodes.
  let user = await prisma.user.findFirst({
    where: { mobile: identifier, isDeleted: false },
  });
  if (!user) {
    user = await prisma.user.findUnique({ where: { studentId: identifier } });
  }

  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, 'No account found with this mobile or student ID');
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
      mobile: user.mobile,
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
  // Same dual-key resolution as login.
  const identifier = (payload.mobile ?? payload.studentId ?? '').trim();
  if (!identifier) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Mobile or student ID is required');
  }

  // Mobile lookup goes via `findFirst` because the mobile uniqueness
  // lives in a partial unique index — see the comment in signInUserToDB.
  let user = await prisma.user.findFirst({
    where: { mobile: identifier, isDeleted: false },
  });
  if (!user) {
    user = await prisma.user.findUnique({ where: { studentId: identifier } });
  }
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

  // `to` previously took `user.studentId` as a stand-in for an email
  // address — since real production deployments won't have email on
  // file for students, fall back to mobile-as-identifier so we don't
  // accidentally send a "reset" email to a phone-looking string.
  await sendEmail({
    to: user.mobile ?? user.studentId,
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
      // Mobile also matches the admin search so a super admin can look
      // up an admin by their phone number as well.
      { mobile: { contains: filters.searchTerm, mode: 'insensitive' } },
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
        mobile: true,
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

/**
 * Mint the next free `SMC-ADMIN-NNN` user ID by scanning the existing
 * rows for the largest numeric suffix and adding 1. Used by
 * `createUserToDB` so the super admin never has to pick a free slot
 * manually — collisions are prevented by retrying on the (extremely
 * rare) duplicate-key error from the unique index on `studentId`.
 *
 * The `raw` findMany + reduce beats a SQL `MAX(...)` here because:
 *  - the table is small (only admins), so pulling every SMC-ADMIN-*
 *    row is trivial;
 *  - the regex split keeps the implementation DB-agnostic and easy to
 *    reason about;
 *  - we still wrap the read+create in a $transaction below so two
 *    concurrent admins can't both pick the same slot.
 */
const generateNextAdminStudentId = async (
  tx: Pick<typeof prisma, 'user'>,
): Promise<string> => {
  // Pull every candidate row in one go. `findMany` doesn't expose a
  // SQL `LIKE`-style filter directly without `mode: 'insensitive'`
  // which would slow the scan; we use `startsWith` which translates
  // to `LIKE 'SMC-ADMIN-%'` and is fast on the studentId index.
  const rows = await tx.user.findMany({
    where: { studentId: { startsWith: 'SMC-ADMIN-' } },
    select: { studentId: true },
  });
  let max = 0;
  for (const row of rows) {
    const suffix = row.studentId.slice('SMC-ADMIN-'.length);
    const n = Number.parseInt(suffix, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  const next = max + 1;
  return `SMC-ADMIN-${String(next).padStart(3, '0')}`;
};

const updateUserInDB = async (
  id: string,
  payload: { name?: string; password?: string; mobile?: string | null },
) => {
  const data: Record<string, unknown> = {};
  if (payload.name) data.name = payload.name;
  // The validation schema turns `""` into `null` so the admin can
  // explicitly clear the mobile. We only write when the key was
  // actually present in the payload — `undefined` means "don't touch",
  // anything else (including `null`) means "set it to this".
  if ('mobile' in payload) {
    data.mobile = payload.mobile === undefined ? null : payload.mobile;
  }
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
  name: string;
  password: string;
  role: 'SUPER_ADMIN' | 'ADMIN' | 'STUDENT';
  mobile?: string;
}) => {
  const hashed = await bcrypt.hash(
    payload.password,
    Number(config.bcryptSaltRounds) || 12,
  );

  // Student creation still passes a `studentId` (computed by the admit
  // flow); the user-management flow doesn't, so we mint the next
  // `SMC-ADMIN-NNN` here. If two admins race and pick the same slot,
  // the unique index on `User.studentId` rejects the second insert —
  // retry up to a few times before surfacing the error.
  if (payload.role === 'STUDENT') {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Students are created via the admit-student flow, not the user-management endpoint',
    );
  }

  const MAX_ATTEMPTS = 5;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const studentId = await generateNextAdminStudentId(tx);
        return tx.user.create({
          data: {
            studentId,
            name: payload.name,
            password: hashed,
            role: payload.role,
            mobile: payload.mobile || null,
            mustChangePassword: false,
            passwordLevel: 1,
            passwordChangedAt: new Date(),
          },
        });
      });
    } catch (err) {
      // P2002 = unique constraint violation. Only retry if it's the
      // studentId column; everything else bubbles up immediately.
      const code = (err as { code?: string }).code;
      const target = (err as { meta?: { target?: string[] } }).meta?.target;
      const isStudentIdClash =
        code === 'P2002' && Array.isArray(target) && target.includes('studentId');
      if (!isStudentIdClash) throw err;
      lastError = err;
    }
  }
  throw (
    lastError ??
    new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      'Failed to allocate a unique admin user ID',
    )
  );
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