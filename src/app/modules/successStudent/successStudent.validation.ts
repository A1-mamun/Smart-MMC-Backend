import { z } from 'zod';

/**
 * Body schema for POST /success-student — admin confirms a Cloudinary
 * upload by handing back the (secure_url, public_id) the browser got
 * from Cloudinary, plus the three text fields the card needs. We
 * re-validate everything server-side so a malicious client can't
 * insert arbitrary URLs or hijack another tenant's publicId.
 *
 * The three text fields (name / institute / batch) are all required
 * and trimmed. `batch` is the display string ("Batch 25") rather
 * than the HscBatch enum value — see the SuccessStudent Prisma
 * model docstring for why we don't parse it.
 */
export const createSuccessStudentSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(100),
    institute: z.string().trim().min(1).max(150),
    batch: z.string().trim().min(1).max(50),
    imageUrl: z.string().url().max(2048),
    publicId: z.string().min(1).max(255),
  }),
});

/**
 * Path param for DELETE /success-student/:id. UUID validation so a
 * crafted `?id=...` can't trigger a Prisma error before reaching
 * the service.
 */
export const successStudentIdParamSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

/**
 * Body schema for POST /success-student/sign. The browser calls this
 * to get a signed payload it then sends to Cloudinary. `folder` is
 * optional (defaults to the server-side `CLOUDINARY_FOLDER`); we
 * accept a custom one for the (rare) case where a super admin wants
 * to upload to a subfolder for organisational reasons.
 */
export const signUploadSchema = z.object({
  body: z
    .object({
      folder: z
        .string()
        .min(1)
        .max(255)
        .regex(/^[a-zA-Z0-9_\-/]+$/, {
          message:
            'folder may only contain letters, digits, underscore, hyphen, slash',
        })
        .optional(),
    })
    .optional(),
});

export const SuccessStudentValidation = {
  createSuccessStudentSchema,
  successStudentIdParamSchema,
  signUploadSchema,
};

export type TCreateSuccessStudent = z.infer<
  typeof createSuccessStudentSchema
>['body'];
export type TSignUploadBody = z.infer<typeof signUploadSchema>['body'];
