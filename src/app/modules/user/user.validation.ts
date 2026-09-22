import { z } from 'zod';
import { paginationFields } from '../../constant/pagination';
import { USER_ROLE } from '../../constant/userConstant';

const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{6,}$/;
// Same BD mobile regex as the auth sign-in schema — admins need a
// well-formed 01X-NXXXXXXX number so they can also log in via mobile
// (see signInUserToDB which looks up by mobile first, then studentId).
const mobileRegex = /^01[3-9]\d{8}$/;

const createUserValidationSchema = z.object({
  body: z
    .object({
      // `studentId` is intentionally NOT accepted from the client for
      // role=SUPER_ADMIN / ADMIN — those user IDs follow the
      // `SMC-ADMIN-NNN` sequence and are minted server-side at creation
      // time so the super admin doesn't have to think about collisions
      // or pick the next free slot. Students still get their `studentId`
      // generated via `generateStudentId` at admit time, so this only
      // affects the user-management flow.
      name: z.string().min(2).max(100),
      password: z
        .string()
        .min(6)
        .regex(passwordRegex, 'Weak password'),
      role: z.enum([USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN, USER_ROLE.STUDENT]),
      // Optional at the field level — admins REQUIRE a mobile (see the
      // superRefine below), other roles can omit it. When provided it
      // has to be a valid BD mobile; an empty string is normalised to
      // `undefined` so the column stays NULL.
      mobile: z
        .string()
        .regex(mobileRegex, 'Invalid BD mobile (e.g. 01712345678)')
        .optional()
        .or(z.literal('').transform(() => undefined)),
    })
    .superRefine((data, ctx) => {
      // ADMIN users MUST have a mobile on file so they can sign in via
      // mobile + password (mirrors students). The same applies when a
      // SUPER_ADMIN is being created through this endpoint — we want a
      // contact point on every non-student profile. The check is
      // symmetric and matches what the UI marks as required.
      if (
        (data.role === USER_ROLE.ADMIN || data.role === USER_ROLE.SUPER_ADMIN) &&
        !data.mobile
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['mobile'],
          message: 'Mobile number is required for admin and super admin accounts',
        });
      }
    }),
});

const updateUserValidationSchema = z.object({
  body: z.object({
    name: z.string().min(2).max(100).optional(),
    // `studentId` is intentionally not editable for admins — the
    // `SMC-ADMIN-NNN` identifier is system-managed and stays stable
    // for the life of the account.
    password: z
      .string()
      .min(6)
      .regex(passwordRegex, 'Weak password')
      .optional(),
    // Empty string → null (clear the field), valid BD mobile → set it,
    // missing key → leave the column untouched. The literal('') +
    // transform handles the "blank out the mobile" case from the UI.
    mobile: z
      .string()
      .regex(mobileRegex, 'Invalid BD mobile (e.g. 01712345678)')
      .optional()
      .or(z.literal('').transform(() => null)),
  }),
  params: z.object({ id: z.string().uuid() }),
});

const getAllUsersValidationSchema = z.object({
  query: z.object({
    searchTerm: z.string().optional(),
    role: z
      .enum([USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN, USER_ROLE.STUDENT])
      .optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
  }),
});

const idParamValidationSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

export const UserValidation = {
  createUserValidationSchema,
  updateUserValidationSchema,
  getAllUsersValidationSchema,
  idParamValidationSchema,
};

export type TCreateUser = z.infer<typeof createUserValidationSchema>['body'];
export type TUpdateUser = z.infer<typeof updateUserValidationSchema>;
export type TGetAllUsers = z.infer<typeof getAllUsersValidationSchema>['query'];

export { paginationFields };