import { z } from 'zod';

/**
 * Caption is optional. An empty string (from a cleared textarea) is
 * normalised to `undefined` so the DB column stays NULL rather than
 * being written as the empty string. Trimmed to 200 chars to keep
 * the overlay readable; longer captions should be a blog post.
 */
const captionSchema = z
  .string()
  .trim()
  .max(200)
  .optional()
  .or(z.literal('').transform(() => undefined));

/**
 * Body schema for POST /banner — admin confirms a Cloudinary upload
 * by handing back the (secure_url, public_id) the browser got from
 * Cloudinary, plus the optional caption. We re-validate everything
 * server-side so a malicious client can't insert arbitrary URLs or
 * hijack another tenant's publicId.
 */
export const createBannerSchema = z.object({
  body: z.object({
    imageUrl: z.string().url().max(2048),
    publicId: z.string().min(1).max(255),
    caption: captionSchema,
  }),
});

/**
 * Path param for DELETE /banner/:id. We use UUID validation so a
 * crafted `?id=...` can't trigger a Prisma error before reaching the
 * service.
 */
export const bannerIdParamSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

/**
 * Body schema for POST /banner/sign. The browser calls this to get
 * a signed payload it then sends to Cloudinary. `folder` is optional
 * (defaults to the server-side `CLOUDINARY_FOLDER`); we accept a
 * custom one for the (rare) case where a super admin wants to upload
 * to a subfolder for organisational reasons.
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

export const BannerValidation = {
  createBannerSchema,
  bannerIdParamSchema,
  signUploadSchema,
};

export type TCreateBanner = z.infer<typeof createBannerSchema>['body'];
export type TSignUploadBody = z.infer<typeof signUploadSchema>['body'];
