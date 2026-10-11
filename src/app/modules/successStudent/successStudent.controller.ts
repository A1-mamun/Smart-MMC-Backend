import httpStatus from 'http-status';
import { JwtPayload } from 'jsonwebtoken';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { SuccessStudentService } from './successStudent.service';
import { TCreateSuccessStudent, TSignUploadBody } from './successStudent.validation';

/**
 * POST /success-student/sign — admin gets a signed payload for the
 * next direct-to-Cloudinary upload. Returns the params the browser
 * needs to append to its multipart POST to Cloudinary (signature,
 * timestamp, apiKey, cloudName, uploadPreset, folder).
 */
const signUpload = catchAsync(async (req, res) => {
  const params = SuccessStudentService.signUploadParamsFromDB(
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
 * GET /success-student — public, no auth. The landing page fetches
 * this. The 60s cache is applied via the route's `cache(60)`
 * middleware.
 */
const getSuccessStudents = catchAsync(async (_req, res) => {
  const list = await SuccessStudentService.getSuccessStudentsFromDB();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Success students fetched',
    data: list,
  });
});

/**
 * POST /success-student — admin confirms a Cloudinary upload by
 * handing back the (imageUrl, publicId) Cloudinary returned, plus
 * the three text fields. The service inserts the row and
 * invalidates the public list cache.
 */
const createSuccessStudent = catchAsync(async (req, res) => {
  const created = await SuccessStudentService.createSuccessStudentInDB(
    req.body as TCreateSuccessStudent,
    req.user as JwtPayload,
  );
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: 'Success student added',
    data: created,
  });
});

/**
 * DELETE /success-student/:id — admin deletes a success student.
 * The service also destroys the file on Cloudinary so no orphan
 * remains. Returns the deleted row so the UI can show a success
 * toast with the student name.
 */
const deleteSuccessStudent = catchAsync(async (req, res) => {
  const deleted = await SuccessStudentService.deleteSuccessStudentFromDB(req.params.id as string);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Success student deleted',
    data: deleted,
  });
});

export const SuccessStudentController = {
  signUpload,
  getSuccessStudents,
  createSuccessStudent,
  deleteSuccessStudent,
};
