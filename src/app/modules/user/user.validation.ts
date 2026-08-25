import { z } from 'zod';
import { paginationFields } from '../../constant/pagination';
import { USER_ROLE } from '../../constant/userConstant';

const studentIdRegex = /^SMC-[A-Z0-9-]+$/i;
const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{6,}$/;

const createUserValidationSchema = z.object({
  body: z.object({
    studentId: z
      .string()
      .min(1)
      .regex(studentIdRegex, 'Invalid student ID format'),
    name: z.string().min(2).max(100),
    password: z
      .string()
      .min(6)
      .regex(passwordRegex, 'Weak password'),
    role: z.enum([USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN, USER_ROLE.STUDENT]),
  }),
});

const updateUserValidationSchema = z.object({
  body: z.object({
    name: z.string().min(2).max(100).optional(),
    studentId: z
      .string()
      .regex(studentIdRegex, 'Invalid student ID format')
      .optional(),
    password: z
      .string()
      .min(6)
      .regex(passwordRegex, 'Weak password')
      .optional(),
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