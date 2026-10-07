import { z } from 'zod';
import { USER_ROLE } from '../../constant/userConstant';

// Login identifier: mobile is the only canonical handle now. The
// legacy `studentId` field was a parallel SMC-ADMIN-NNN / HSC-format
// identifier that has been dropped from the User model (see
// ../../../../prisma/migrations/20261005125911_drop_user_student_id_use_mobile).
// The legacy regexes are intentionally retained here so the wire
// schema document, but they no longer accept input.
const phoneRegex = /^01[3-9]\d{8}$/;
const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{6,}$/;

const loginValidationSchema = z.object({
  body: z.object({
    // Mobile is the canonical login handle for every account type
    // (student / admin / super admin). Required for every sign-in.
    mobile: z
      .string()
      .regex(phoneRegex, 'Mobile must be a valid BD number (e.g. 01712345678)'),
    password: z.string().min(1, 'Password is required'),
  }),
});

const changePasswordValidationSchema = z.object({
  body: z.object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z
      .string()
      .min(6, 'Password must be at least 6 characters')
      .regex(
        passwordRegex,
        'Password must contain uppercase, lowercase and a number',
      ),
  }),
});

const forgotPasswordValidationSchema = z.object({
  body: z.object({
    // Same single-key pattern as login — mobile is the only lookup
    // handle now.
    mobile: z
      .string()
      .regex(phoneRegex, 'Mobile must be a valid BD number'),
  }),
});

const resetPasswordValidationSchema = z.object({
  body: z.object({
    token: z.string().min(10, 'Invalid token'),
    newPassword: z
      .string()
      .min(6, 'Password must be at least 6 characters')
      .regex(
        passwordRegex,
        'Password must contain uppercase, lowercase and a number',
      ),
  }),
});

const refreshTokenValidationSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(10).optional(),
  }),
});

export const AuthValidation = {
  loginValidationSchema,
  changePasswordValidationSchema,
  forgotPasswordValidationSchema,
  resetPasswordValidationSchema,
  refreshTokenValidationSchema,
};

export type TLogin = z.infer<typeof loginValidationSchema>['body'];
export type TChangePassword = z.infer<typeof changePasswordValidationSchema>['body'];
export type TForgotPassword = z.infer<typeof forgotPasswordValidationSchema>['body'];
export type TResetPassword = z.infer<typeof resetPasswordValidationSchema>['body'];

// Re-export the role constants so downstream modules that import
// from this file (e.g. auth.controller) don't have to reach into the
// separate constant module.
export { USER_ROLE };