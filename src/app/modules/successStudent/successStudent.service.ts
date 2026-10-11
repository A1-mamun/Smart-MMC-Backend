import crypto from 'crypto';
import { v2 as cloudinary } from 'cloudinary';
import { JwtPayload } from 'jsonwebtoken';
import config from '../../config';
import prisma from '../../utils/prisma';
import { clearCacheByPattern } from '../../utils/clearCache';
import { TCreateSuccessStudent, TSignUploadBody } from './successStudent.validation';

/**
 * Sign an upload. The browser takes the returned params and POSTs
 * them as form-data to Cloudinary along with the file. The signature
 * proves the upload was authorised by us (the holder of the API
 * secret); Cloudinary verifies it against the upload preset, which
 * MUST be configured with `mode: signed` for this to work.
 *
 * We sign `folder` and `timestamp` (alphabetically sorted, joined
 * with `&`, then `sha1(queryString + api_secret)`). The upload
 * preset itself is NOT part of the signature — Cloudinary looks it
 * up by name and uses its stored config (folder, transformations,
 * allowed formats) to validate the request.
 *
 * NOTE: this module shares the Cloudinary SDK with `banner.service.ts`
 * (the `v2` SDK is process-global once `cloudinary.config()` is
 * called, which `banner.service.ts` does at module load). We
 * intentionally don't re-init it here — the config object is the
 * same source of truth either way.
 */
const signUploadParamsFromDB = (
  _actor: JwtPayload,
  body?: TSignUploadBody,
): {
  signature: string;
  timestamp: number;
  apiKey: string;
  cloudName: string;
  uploadPreset: string;
  folder: string;
} => {
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = body?.folder || (config.cloudinaryFolder as string);
  const uploadPreset = config.cloudinaryUploadPreset as string;

  // Params to sign — sorted alphabetically (Cloudinary's hard
  // requirement; a wrong sort order produces a 401 from Cloudinary
  // with no clear error message).
  //
  // Every parameter we send in the multipart body MUST appear in
  // the signed string — except `file` (the binary), `api_key`
  // (Cloudinary looks it up by itself), and the `signature` itself.
  // In particular, `upload_preset` MUST be signed: when the preset
  // is included in the upload request, Cloudinary includes it in
  // the string it verifies against, so omitting it from our signed
  // string produces a 401 with "Invalid Signature" and the
  // "String to sign" diagnostic showing the preset where we'd
  // computed ours without it.
  const paramsToSign: Record<string, string | number> = {
    folder,
    timestamp,
    upload_preset: uploadPreset,
  };
  const sortedKeys = Object.keys(paramsToSign).sort();
  const queryString = sortedKeys.map((k) => `${k}=${paramsToSign[k]}`).join('&');
  const signature = crypto
    .createHash('sha1')
    .update(queryString + config.cloudinaryApiSecret)
    .digest('hex');

  return {
    signature,
    timestamp,
    apiKey: config.cloudinaryApiKey as string,
    cloudName: config.cloudinaryCloudName as string,
    uploadPreset,
    folder,
  };
};

/**
 * Public list — newest first. Includes a small projection of
 * `createdBy` so the admin list page can show "added by X" without
 * a separate query. We don't paginate yet (count is small); if it
 * ever grows past ~50 rows, add `take`/`skip` here.
 *
 * Cached 60s at the route layer; this function is the underlying
 * read so we don't bake cache concerns into the service.
 */
const getSuccessStudentsFromDB = () =>
  prisma.successStudent.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      createdBy: { select: { id: true, name: true, role: true } },
    },
  });

/**
 * Insert a new SuccessStudent row after the browser has confirmed
 * the Cloudinary upload. We store the (imageUrl, publicId) pair
 * verbatim from the response — no transformation here. If the admin
 * mis-configures Cloudinary (e.g. wrong folder) the URL still works;
 * the file is just in a different place.
 *
 * The actor's userId is required for the FK. We don't store the
 * actor's role; that's already on the User row.
 */
const createSuccessStudentInDB = async (data: TCreateSuccessStudent, actor: JwtPayload) => {
  const created = await prisma.successStudent.create({
    data: {
      name: data.name,
      institute: data.institute,
      batch: data.batch,
      imageUrl: data.imageUrl,
      publicId: data.publicId,
      createdById: actor.userId as string,
    },
  });
  // Invalidate the public list cache so the next GET /success-student
  // returns the fresh row. We swallow errors here — if Redis is
  // down, the cache will simply expire in <= 60s anyway.
  await clearCacheByPattern('cache:/api/v1/success-student*').catch(() => undefined);
  return created;
};

/**
 * Delete a success student. The order matters:
 *   1. Look up the row (returns null if it doesn't exist — service
 *      consumer handles 404).
 *   2. Call Cloudinary's destroy first. If THIS fails, we throw —
 *      the DB row stays so the admin can retry. An orphan file on
 *      Cloudinary is recoverable from the public_id, but a DB row
 *      pointing at a missing publicId is the worse state.
 *   3. Delete the DB row.
 *   4. Invalidate the cache.
 */
const deleteSuccessStudentFromDB = async (id: string) => {
  const row = await prisma.successStudent.findUnique({ where: { id } });
  if (!row) return null;

  // `invalidate: true` tells Cloudinary to also invalidate any
  // derived CDN caches. With secure: true in the SDK config (set
  // by banner.service.ts), the call goes over HTTPS.
  await cloudinary.uploader.destroy(row.publicId, { invalidate: true });

  await prisma.successStudent.delete({ where: { id } });
  await clearCacheByPattern('cache:/api/v1/success-student*').catch(() => undefined);
  return row;
};

export const SuccessStudentService = {
  signUploadParamsFromDB,
  getSuccessStudentsFromDB,
  createSuccessStudentInDB,
  deleteSuccessStudentFromDB,
};
