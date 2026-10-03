import jwt, { JwtPayload } from 'jsonwebtoken';
import crypto from 'crypto';
import config from '../../config';
import { TUserRole } from '../../interface/userRole';

export type TJwtPayload = {
  userId: string;
  name: string;
  role: TUserRole;
  studentId: string;
  // Free-class lifecycle flag — surfaced into the access token so the
  // frontend can route free users to /dashboard/free-classes without an
  // extra /auth/me roundtrip. Defaults to false on paid/admin tokens.
  isFreeAccount?: boolean;
  // Per-token unique id (JWT `jti`). Two logins within the same second
  // otherwise produce byte-identical refresh tokens (same payload, same
  // exp, same secret) which collide on RefreshToken.token's @unique
  // constraint. crypto.randomUUID keeps each refresh token unique
  // without invalidating the user-facing claims the frontend relies on.
  jti?: string;
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
  // Always mint a fresh jti so consecutive refresh tokens for the same
  // user can't collide on the @unique RefreshToken.token index. The jti
  // is included in the signed JWT so it's verifiable downstream.
  return jwt.sign(
    { ...payload, jti: crypto.randomUUID() },
    config.jwtRefreshSecret as string,
    {
      expiresIn: config.jwtRefreshExpiresIn,
    } as jwt.SignOptions,
  );
};

export const verifyRefreshToken = (token: string): TJwtPayload => {
  return jwt.verify(token, config.jwtRefreshSecret as string) as TJwtPayload;
};

export const generateResetToken = (): string => {
  return crypto.randomBytes(32).toString('hex');
};

export type TDecoded = JwtPayload & TJwtPayload;