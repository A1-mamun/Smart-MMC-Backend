import { z } from 'zod';

const phoneRegex = /^01[3-9]\d{8}$/;
const hscBatches = ['BATCH_25', 'BATCH_26', 'BATCH_27', 'BATCH_28'] as const;
const intakeModes = ['ONLINE', 'OFFLINE'] as const;
// Mirrors the auth validation — students need a real password they can
// remember so they can log in via the regular /auth/sign-in later.
const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{6,}$/;

const signupSchema = z
  .object({
    body: z.object({
      name: z.string().min(2).max(100),
      mobile: z.string().regex(phoneRegex, 'Invalid BD mobile number'),
      // Explicit password chosen by the student. Confirmed client-side
      // and re-validated server-side so an empty / weak password never
      // reaches the user table.
      password: z
        .string()
        .min(6, 'Password must be at least 6 characters')
        .regex(
          passwordRegex,
          'Password must contain uppercase, lowercase and a number',
        ),
      hscBatch: z.enum(hscBatches),
      college: z.string().max(200).optional().or(z.literal('')),
      intakeMode: z.enum(intakeModes),
    }),
  });

const loginSchema = z.object({
  body: z.object({
    mobile: z.string().regex(phoneRegex, 'Invalid BD mobile number'),
    password: z.string().min(1, 'Password is required'),
  }),
});

const topicIdParam = z.object({
  params: z.object({
    topicId: z.string().uuid('Invalid topic id'),
  }),
});

export const FreeClassValidation = {
  signupSchema,
  loginSchema,
  topicIdParam,
};

export type TFreeSignup = z.infer<typeof signupSchema>['body'];
export type TFreeLogin = z.infer<typeof loginSchema>['body'];