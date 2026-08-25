import { z } from 'zod';
import { USER_ROLE } from '../../constant/userConstant';

// Accepts:
//  - SMC-... IDs (legacy / admin / reset tokens)
//  - New HSC-format IDs: {hsc_batch_number 2 digits}{year_digit 1 digit}{3-digit roll starting at 200}
//    Examples: 271200 (HSC 27, 1st year, roll 200), 282201 (HSC 28, 2nd year, roll 201)
const legacyStudentIdRegex = /^SMC-[A-Z0-9-]+$/i;
const hscStudentIdRegex = /^(2[5-8])[1-4]\d{3}$/;
const studentIdRegex = new RegExp(`(?:${legacyStudentIdRegex.source})|(?:${hscStudentIdRegex.source})`);
const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{6,}$/;

const loginValidationSchema = z.object({
  body: z.object({
    studentId: z
      .string()
      .min(1, 'Student ID is required')
      .regex(studentIdRegex, 'Invalid student ID format'),
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
    studentId: z
      .string()
      .min(1, 'Student ID is required')
      .regex(studentIdRegex, 'Invalid student ID format'),
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