import jwt, { JwtPayload } from 'jsonwebtoken';
import crypto from 'crypto';
import config from '../../config';
import { TUserRole } from '../../interface/userRole';

export type TJwtPayload = {
  userId: string;
  name: string;
  role: TUserRole;
  studentId: string;
  iat?: number;
  exp?: number;
};

export const generateAccessToken = (
  payload: Omit<TJwtPayload, 'iat' | 'exp'>,
): string => {
  return jwt.sign(payload, config.jwtAccessSecret as string, {
    expiresIn: config.jwtAccessExpiresIn,
  } as jwt.SignOptions);
};

export const generateRefreshToken = (
  payload: Omit<TJwtPayload, 'iat' | 'exp'>,
): string => {
  return jwt.sign(payload, config.jwtRefreshSecret as string, {
    expiresIn: config.jwtRefreshExpiresIn,
  } as jwt.SignOptions);
};

export const verifyRefreshToken = (token: string): TJwtPayload => {
  return jwt.verify(token, config.jwtRefreshSecret as string) as TJwtPayload;
};

export const generateResetToken = (): string => {
  return crypto.randomBytes(32).toString('hex');
};

export type TDecoded = JwtPayload & TJwtPayload;