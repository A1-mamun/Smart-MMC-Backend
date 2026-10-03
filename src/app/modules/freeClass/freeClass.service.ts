import bcrypt from 'bcrypt';
import httpStatus from 'http-status';
import crypto from 'crypto';
import config from '../../config';
import prisma from '../../utils/prisma';
import AppError from '../../errors/AppError';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
} from '../auth/auth.utils';
import { TUserRole } from '../../interface/userRole';
import { TFreeSignup, TFreeLogin } from './freeClass.validation';

/**
 * Mirrors the auth.service constants — kept here as a literal so the
 * free-class module stays self-contained (no import cycle through auth).
 */
const FREE_PASSWORD_PLACEHOLDER_FATHER_MOBILE = '00000000000';
const FREE_PASSWORD_PLACEHOLDER_TEXT = 'FREE-pending';

/**
 * Short, URL-safe id for free-account users. e.g. `FREE-3a4b5c6d`. The
 * "FREE-" prefix makes `startsWith: 'FREE-'` a fast admin-side filter.
 */
const mintFreeStudentId = (): string =>
  `FREE-${crypto.randomBytes(4).toString('hex')}`;

const hashFreePassword = (plain: string) =>
  bcrypt.hash(plain, Number(config.bcryptSaltRounds) || 12);

const signTokens = (
  user: {
    id: string;
    studentId: string;
    name: string;
    role: 'STUDENT';
    isFreeAccount: boolean;
  },
) => {
  const tokenPayload = {
    userId: user.id,
    name: user.name,
    role: user.role as TUserRole,
    studentId: user.studentId,
    isFreeAccount: user.isFreeAccount,
  };
  const accessToken = generateAccessToken(tokenPayload);
  const refreshToken = generateRefreshToken(tokenPayload);
  const decoded = verifyRefreshToken(refreshToken);
  const expiresAt = new Date((decoded.exp as number) * 1000);
  return { accessToken, refreshToken, expiresAt };
};

/**
 * For the login flow the User already exists in the DB, so we can write
 * the RefreshToken via the top-level client without a transaction.
 */
const signTokensAndPersist = async (
  user: {
    id: string;
    studentId: string;
    name: string;
    role: 'STUDENT';
    isFreeAccount: boolean;
  },
) => {
  const { accessToken, refreshToken, expiresAt } = signTokens(user);
  await prisma.refreshToken.create({
    data: { token: refreshToken, userId: user.id, expiresAt },
  });
  return { accessToken, refreshToken };
};

/**
 * For the signup flow the User row is created inside the same
 * transaction as the RefreshToken — Postgres needs the parent row to be
 * visible to honour the FK constraint, and the transaction's commit is
 * what makes that happen.
 */
const signTokensAndPersistInTx = async (
  tx: Pick<typeof prisma, 'refreshToken'>,
  user: {
    id: string;
    studentId: string;
    name: string;
    role: 'STUDENT';
    isFreeAccount: boolean;
  },
) => {
  const { accessToken, refreshToken, expiresAt } = signTokens(user);
  await tx.refreshToken.create({
    data: { token: refreshToken, userId: user.id, expiresAt },
  });
  return { accessToken, refreshToken };
};

const signUpFreeStudentToDB = async (payload: TFreeSignup) => {
  // Mobile uniqueness lives in a partial unique index
  // (`mobile IS NOT NULL AND isDeleted = false`) — `findUnique` can't
  // express it, so we use `findFirst` and re-apply the predicate.
  const existing = await prisma.user.findFirst({
    where: { mobile: payload.mobile, isDeleted: false },
    select: { id: true, isFreeAccount: true },
  });

  if (existing) {
    if (existing.isFreeAccount) {
      throw new AppError(
        httpStatus.CONFLICT,
        'Looks like you already signed up. Please sign in with your mobile number.',
      );
    }
    throw new AppError(
      httpStatus.CONFLICT,
      'This number is already registered, please sign in',
    );
  }

  const hashed = await hashFreePassword(payload.password);
  const studentId = mintFreeStudentId();
  const now = new Date();

  // We retry on the (extremely unlikely) unique-studentId clash — see
  // admin.createUserToDB for the same pattern. Cap at 5 attempts.
  const MAX_ATTEMPTS = 5;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            studentId: attempt === 0 ? studentId : mintFreeStudentId(),
            mobile: payload.mobile,
            name: payload.name,
            password: hashed,
            role: 'STUDENT',
            mustChangePassword: false,
            passwordLevel: 1,
            passwordChangedAt: now,
            isFreeAccount: true,
            freeSignupAt: now,
            freeSignupSource: payload.intakeMode,
          },
        });

        const student = await tx.student.create({
          data: {
            userId: user.id,
            mobile: payload.mobile,
            // The free signup form doesn't capture these — admins fill
            // them in via EditStudentForm before admitting the student
            // to a paid course. Placeholders pass the NOT NULL constraint.
            fatherName: FREE_PASSWORD_PLACEHOLDER_TEXT,
            fatherOccupation: FREE_PASSWORD_PLACEHOLDER_TEXT,
            fatherMobile: FREE_PASSWORD_PLACEHOLDER_FATHER_MOBILE,
            sscInstitute: FREE_PASSWORD_PLACEHOLDER_TEXT,
            college: payload.college || null,
            // addressDistrict / addressUpozila are NOT NULL on the legacy
            // Student schema. The free signup form no longer captures them,
            // so we stamp a placeholder the admin can overwrite via
            // EditStudentForm when admitting the student to a paid course.
            addressDistrict: FREE_PASSWORD_PLACEHOLDER_TEXT,
            addressUpozila: FREE_PASSWORD_PLACEHOLDER_TEXT,
            admittedBy: user.id, // self-reference; admin re-admit overwrites this
            intakeMode: payload.intakeMode,
            isFreeAccount: true,
            freeSignupAt: now,
            freeHscBatch: payload.hscBatch,
          },
        });

        const tokens = await signTokensAndPersistInTx(tx, {
          id: user.id,
          studentId: user.studentId,
          name: user.name,
          role: 'STUDENT',
          isFreeAccount: true,
        });

        return {
          user: {
            id: user.id,
            studentId: user.studentId,
            mobile: user.mobile,
            name: user.name,
            role: user.role,
            mustChangePassword: user.mustChangePassword,
            isFreeAccount: true,
          },
          student: {
            id: student.id,
            isFreeAccount: true,
            freeSignupAt: student.freeSignupAt?.toISOString() ?? null,
          },
          ...tokens,
        };
      });
    } catch (err) {
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
      'Failed to allocate a unique free-class student ID',
    )
  );
};

const freeLoginToDB = async (payload: TFreeLogin) => {
  const user = await prisma.user.findFirst({
    where: { mobile: payload.mobile, isDeleted: false },
  });
  if (!user) {
    throw new AppError(
      httpStatus.NOT_FOUND,
      'No account found with this mobile number',
    );
  }
  if (user.status === 'BANNED') {
    throw new AppError(httpStatus.FORBIDDEN, 'This account has been banned');
  }

  const matched = await bcrypt.compare(payload.password, user.password);
  if (!matched) {
    throw new AppError(httpStatus.UNAUTHORIZED, 'Invalid credentials');
  }

  if (!user.isFreeAccount) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      'This account is not a free-class account. Please sign in via the regular portal.',
    );
  }

  const tokens = await signTokensAndPersist({
    id: user.id,
    studentId: user.studentId,
    name: user.name,
    role: 'STUDENT',
    isFreeAccount: true,
  });

  return {
    user: {
      id: user.id,
      studentId: user.studentId,
      mobile: user.mobile,
      name: user.name,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      isFreeAccount: true,
    },
    tokens,
  };
};

/**
 * Public content tree — DOES NOT include `providerVideoId`,
 * `providerEmbedUrl`, or `vdoCipherOtp`. Those fields stay server-side
 * and only leak via the authenticated /play endpoint, so a curious user
 * can never fish a private YouTube/VdoCipher id out of the content
 * payload.
 */
const getFreeContentFromDB = async () => {
  return prisma.freeSubject.findMany({
    where: { isPublished: true },
    orderBy: { position: 'asc' },
    include: {
      chapters: {
        where: { isPublished: true },
        orderBy: { position: 'asc' },
        include: {
          topics: {
            where: { isPublished: true },
            orderBy: { position: 'asc' },
            select: {
              id: true,
              title: true,
              position: true,
              thumbnailUrl: true,
              durationSeconds: true,
            },
          },
        },
      },
    },
  });
};

/**
 * Returns the playback token for a single topic. Single integration
 * point — when VdoCipher goes live we just add the provider branch here
 * and the frontend renders it through the existing VideoPlayerModal
 * provider abstraction. Also records a `FreeContentView` row so we can
 * later surface "continue watching".
 */
const getFreeTopicPlaybackFromDB = async (
  topicId: string,
  studentId: string,
) => {
  const topic = await prisma.freeTopic.findUnique({ where: { id: topicId } });
  if (!topic || !topic.isPublished) {
    throw new AppError(httpStatus.NOT_FOUND, 'Topic not found');
  }

  let playback:
    | { provider: 'YOUTUBE'; topicId: string; embedUrl: string; expiresAt: string | null }
    | {
        provider: 'VDOCIPHER';
        topicId: string;
        videoId: string;
        otp: string;
        playbackInfo: string;
        expiresAt: string;
      }
    | { provider: 'FILE'; topicId: string; signedUrl: string; expiresAt: string };

  switch (topic.provider) {
    case 'YOUTUBE':
      playback = {
        provider: 'YOUTUBE',
        topicId: topic.id,
        embedUrl: `https://www.youtube.com/embed/${topic.providerVideoId}`,
        expiresAt: null,
      };
      break;
    case 'VDOCIPHER':
      // TODO: mint an OTP via VdoCipher API using config.vdoCipherApiKey,
      // then return { videoId, otp, playbackInfo, expiresAt }.
      throw new AppError(
        httpStatus.NOT_IMPLEMENTED,
        'VdoCipher playback is coming soon',
      );
    case 'FILE':
      throw new AppError(
        httpStatus.NOT_IMPLEMENTED,
        'File playback is coming soon',
      );
  }

  // Audit ledger — `upsert` so repeated plays don't churn rows.
  await prisma.freeContentView.upsert({
    where: { topicId_studentId: { topicId: topic.id, studentId } },
    create: { topicId: topic.id, studentId, watchedSeconds: 0 },
    update: { lastViewedAt: new Date() },
  });

  return playback;
};

/**
 * Convenience wrapper used by the controller: resolves the auth User.id
 * → Student.id (FreeContentView.studentId references Student, not User)
 * and forwards to the raw topic service.
 */
const getFreeTopicPlaybackForUserToDB = async (
  topicId: string,
  userId: string,
) => {
  const student = await prisma.student.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!student) {
    throw new AppError(httpStatus.NOT_FOUND, 'Student profile not found');
  }
  return getFreeTopicPlaybackFromDB(topicId, student.id);
};

export const FreeClassService = {
  signUpFreeStudentToDB,
  freeLoginToDB,
  getFreeContentFromDB,
  getFreeTopicPlaybackFromDB,
  getFreeTopicPlaybackForUserToDB,
};