import httpStatus from 'http-status';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { TErrorSources, TGenericErrorResponse } from '../interface/error';

const handleUniqueError = (
  err: PrismaClientKnownRequestError,
): TGenericErrorResponse => {
  const targetFields = (err.meta?.target as string[]) || ['Field'];
  const target = targetFields.join(', ');
  const errorSources: TErrorSources = targetFields.map((field) => ({
    path: field,
    message: `${field} already exists.`,
  }));

  return {
    statusCode: httpStatus.CONFLICT,
    message: `${target} must be unique.`,
    errorSources,
  };
};

export default handleUniqueError;