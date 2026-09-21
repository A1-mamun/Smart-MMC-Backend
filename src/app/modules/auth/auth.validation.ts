import { z } from 'zod';
import { USER_ROLE } from '../../constant/userConstant';

// Login identifier patterns:
//  - Mobile (new canonical): Bangladesh BD number, e.g. 01712345678
//  - SMC-... IDs (legacy / admin / reset tokens): SMC-ADMIN-001 etc.
//  - HSC-format IDs (legacy student IDs): {hsc_batch_number 2 digits}{year_digit 1 digit}{3-digit roll}
//    Examples: 271200 (HSC 27, 1st year, roll 200), 282201 (HSC 28, 2nd year, roll 201)
const phoneRegex = /^01[3-9]\d{8}$/;
const legacyStudentIdRegex = /^SMC-[A-Z0-9-]+$/i;
const hscStudentIdRegex = /^(2[5-8])[1-4]\d{3}$/;
// Either mobile OR student-id-like. The login flow then resolves the
// identifier to a User row by trying mobile first, then studentId.
const identifierRegex = new RegExp(
  `(?:${phoneRegex.source})|(?:${legacyStudentIdRegex.source})|(?:${hscStudentIdRegex.source})`,
);
const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{6,}$/;

const loginValidationSchema = z.object({
  body: z.object({
    // The login form sends either `mobile` (preferred — students) or
    // `studentId` (admins + legacy students who never migrated). The
    // service looks up by whichever field is non-empty. We accept both
    // keys and validate each independently so the wire payload doesn't
    // have to know about the dual-format rule.
    mobile: z
      .string()
      .regex(phoneRegex, 'Mobile must be a valid BD number (e.g. 01712345678)')
      .optional(),
    studentId: z
      .string()
      .regex(
        new RegExp(
          `(?:${legacyStudentIdRegex.source})|(?:${hscStudentIdRegex.source})`,
        ),
        'Invalid student ID format',
      )
      .optional(),
    password: z.string().min(1, 'Password is required'),
  }).refine(
    (v) => !!(v.mobile || v.studentId),
    { message: 'Mobile or student ID is required', path: ['mobile'] },
  ),
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
    // Same dual-key pattern as login — accept mobile OR studentId.
    mobile: z
      .string()
      .regex(phoneRegex, 'Mobile must be a valid BD number')
      .optional(),
    studentId: z
      .string()
      .regex(
        new RegExp(
          `(?:${legacyStudentIdRegex.source})|(?:${hscStudentIdRegex.source})`,
        ),
        'Invalid student ID format',
      )
      .optional(),
  }).refine(
    (v) => !!(v.mobile || v.studentId),
    { message: 'Mobile or student ID is required', path: ['mobile'] },
  ),
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