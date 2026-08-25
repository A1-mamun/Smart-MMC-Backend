import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { PaymentService } from './payment.service';
import pick from '../../utils/pick';
import { paginationFields } from '../../constant/pagination';
import { JwtPayload } from 'jsonwebtoken';

const recordPayment = catchAsync(async (req, res) => {
  const result = await PaymentService.recordPaymentToDB(
    req.body,
    req.user as JwtPayload,
  );
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: 'Payment recorded successfully',
    data: result,
  });
});

const getAllPayments = catchAsync(async (req, res) => {
  const filters = pick(req.query as Record<string, unknown>, [
    'studentId',
    'courseId',
    'method',
    'startDate',
    'endDate',
    'paid',
  ]);
  const paginationOptions = pick(
    req.query as Record<string, unknown>,
    paginationFields,
  );
  const result = await PaymentService.getAllPaymentsFromDB(
    { ...filters, ...paginationOptions } as Parameters<typeof PaymentService.getAllPaymentsFromDB>[0],
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Payments retrieved successfully',
    meta: result.meta,
    data: result.data,
  });
});

const getDuePayments = catchAsync(async (_req, res) => {
  const result = await PaymentService.getDuePaymentsFromDB();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Due payments retrieved successfully',
    data: result,
  });
});

const getStudentPayments = catchAsync(async (req, res) => {
  const result = await PaymentService.getStudentPaymentsFromDB(req.params.studentId);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Student payments retrieved successfully',
    data: result,
  });
});

const updatePayment = catchAsync(async (req, res) => {
  const result = await PaymentService.updatePaymentInDB(req.params.id, req.body);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Payment updated successfully',
    data: result,
  });
});

const deletePayment = catchAsync(async (req, res) => {
  await PaymentService.deletePaymentFromDB(
    req.params.id,
    req.user as JwtPayload,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Payment deleted successfully',
    data: null,
  });
});

export const PaymentController = {
  recordPayment,
  getAllPayments,
  getDuePayments,
  getStudentPayments,
  updatePayment,
  deletePayment,
};