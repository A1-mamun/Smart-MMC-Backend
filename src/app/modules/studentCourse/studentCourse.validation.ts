import { z } from 'zod';

const enrollSchema = z.object({
  body: z.object({
    studentId: z.string().uuid('Invalid student id'),
    courseId: z.string().uuid('Invalid course id'),
  }),
});

const idParamSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

const studentIdParamSchema = z.object({
  params: z.object({ studentId: z.string().uuid() }),
});

export const StudentCourseValidation = {
  enrollSchema,
  idParamSchema,
  studentIdParamSchema,
};

export type TEnroll = z.infer<typeof enrollSchema>['body'];