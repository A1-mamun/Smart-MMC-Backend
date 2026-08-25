import httpStatus from 'http-status';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { TErrorSources, TGenericErrorResponse } from '../interface/error';

const handleRecordNotFoundError = (
  err: PrismaClientKnownRequestError,
): TGenericErrorResponse => {
  const modelName = (err.meta?.modelName as string) || 'Record';
  const errorSources: TErrorSources = [
    { path: '', message: `${modelName} not found.` },
  ];
  return {
    statusCode: httpStatus.NOT_FOUND,
    message: `${modelName} does not exist.`,
    errorSources,
  };
};

export default handleRecordNotFoundError;