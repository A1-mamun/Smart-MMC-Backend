import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import pick from '../../utils/pick';
import { paginationFields } from '../../constant/pagination';
import { AuthService } from '../auth/auth.service';
import { TCreateUser, TUpdateUser, TGetAllUsers } from './user.validation';

const createUser = catchAsync(async (req, res) => {
  const result = await AuthService.createUserToDB(req.body as TCreateUser);
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: 'User created successfully',
    data: result,
  });
});

const getAllUsers = catchAsync(async (req, res) => {
  const filters = pick(req.query as Record<string, unknown>, ['searchTerm', 'role']);
  const paginationOptions = pick(
    req.query as Record<string, unknown>,
    paginationFields,
  );
  const result = await AuthService.getAllUsersFromDB(
    filters as Pick<TGetAllUsers, 'searchTerm' | 'role'>,
    paginationOptions as Pick<TGetAllUsers, 'page' | 'limit' | 'sortBy' | 'sortOrder'>,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Users retrieved successfully',
    meta: result.meta,
    data: result.data,
  });
});

const getUserById = catchAsync(async (req, res) => {
  const result = await AuthService.getUserByIdFromDB(req.params.id);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'User retrieved successfully',
    data: result,
  });
});

const updateUser = catchAsync(async (req, res) => {
  const result = await AuthService.updateUserInDB(
    req.params.id,
    (req.body as TUpdateUser['body']) || {},
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'User updated successfully',
    data: result,
  });
});

const deleteUser = catchAsync(async (req, res) => {
  const actorId = (req.user as { userId: string }).userId;
  await AuthService.deleteUserFromDB(req.params.id, actorId);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'User deleted successfully',
    data: null,
  });
});

export const UserController = {
  createUser,
  getAllUsers,
  getUserById,
  updateUser,
  deleteUser,
};