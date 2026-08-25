import catchAsync from '../utils/catchAsync';
import httpStatus from 'http-status';
import jwt, { JwtPayload } from 'jsonwebtoken';
import config from '../config';
import AppError from '../errors/AppError';
import prisma from '../utils/prisma';
import { TUserRole } from '../interface/userRole';

const Auth = (...requiredRole: TUserRole[]) => {
  return catchAsync(async (req, _res, next) => {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      throw new AppError(httpStatus.UNAUTHORIZED, 'You are not authorized');
    }

    let decoded: JwtPayload;
    try {
      decoded = jwt.verify(token, config.jwtAccessSecret as string) as JwtPayload;
    } catch (error: unknown) {
      const err = error as { name?: string };
      if (err?.name === 'TokenExpiredError') {
        throw new AppError(httpStatus.UNAUTHORIZED, 'Session expired!');
      }
      throw new AppError(httpStatus.UNAUTHORIZED, 'You are not authorized');
    }

    const { userId, role, iat } = decoded as {
      userId: string;
      role: TUserRole;
      iat: number;
    };

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError(httpStatus.NOT_FOUND, 'This user is not found !');
    if (user.isDeleted)
      throw new AppError(httpStatus.FORBIDDEN, 'This user is deleted !');
    if (user.status === 'BANNED')
      throw new AppError(httpStatus.FORBIDDEN, 'This user is banned !');

    if (
      user.passwordChangedAt &&
      iat < user.passwordChangedAt.getTime() / 1000
    ) {
      throw new AppError(httpStatus.UNAUTHORIZED, 'You are not authorized !');
    }

    if (requiredRole.length > 0 && !requiredRole.includes(role)) {
      throw new AppError(httpStatus.FORBIDDEN, 'You are not authorized');
    }

    req.user = { userId, role, iat } as JwtPayload;
    next();
  });
};

export default Auth;