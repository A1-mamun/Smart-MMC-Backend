import httpStatus from 'http-status';
import { JwtPayload } from 'jsonwebtoken';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { BannerService } from './banner.service';
import { TCreateBanner, TSignUploadBody } from './banner.validation';

/**
 * POST /banner/sign — admin gets a signed payload for the next
 * direct-to-Cloudinary upload. Returns the params the browser needs
 * to append to its multipart POST to Cloudinary (signature, timestamp,
 * apiKey, cloudName, uploadPreset, folder).
 */
const signUpload = catchAsync(async (req, res) => {
  const params = BannerService.signUploadParamsFromDB(
    req.user as JwtPayload,
    req.body as TSignUploadBody,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Upload signed',
    data: params,
  });
});

/**
 * GET /banner — public, no auth. The landing page fetches this. The
 * 60s cache is applied via the route's `cache(60)` middleware.
 */
const getBanners = catchAsync(async (_req, res) => {
  const banners = await BannerService.getBannersFromDB();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Banners fetched',
    data: banners,
  });
});

/**
 * POST /banner — admin confirms a Cloudinary upload by handing back
 * the (imageUrl, publicId) Cloudinary returned. The service inserts
 * the row and invalidates the public list cache.
 */
const createBanner = catchAsync(async (req, res) => {
  const banner = await BannerService.createBannerInDB(
    req.body as TCreateBanner,
    req.user as JwtPayload,
  );
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: 'Banner created',
    data: banner,
  });
});

/**
 * DELETE /banner/:id — admin deletes a banner. The service also
 * destroys the file on Cloudinary so no orphan remains. Returns the
 * deleted row so the UI can show a success toast with the image URL.
 */
const deleteBanner = catchAsync(async (req, res) => {
  const banner = await BannerService.deleteBannerFromDB(req.params.id as string);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Banner deleted',
    data: banner,
  });
});

export const BannerController = {
  signUpload,
  getBanners,
  createBanner,
  deleteBanner,
};
