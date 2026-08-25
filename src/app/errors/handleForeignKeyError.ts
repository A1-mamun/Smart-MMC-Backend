import httpStatus from 'http-status';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { TErrorSources, TGenericErrorResponse } from '../interface/error';

const handleForeignKeyError = (
  err: PrismaClientKnownRequestError,
): TGenericErrorResponse => {
  const fieldName = (err.meta?.field_name as string) || 'field';
  const errorSources: TErrorSources = [
    {
      path: fieldName,
      message: `Invalid reference: ${fieldName} does not exist.`,
    },
  ];
  return {
    statusCode: httpStatus.BAD_REQUEST,
    message: `Invalid reference: ${fieldName} does not exist.`,
    errorSources,
  };
};

export default handleForeignKeyError;