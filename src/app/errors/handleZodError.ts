import httpStatus from 'http-status';
import { ZodError } from 'zod';
import { TErrorSources, TGenericErrorResponse } from '../interface/error';

const handleZodError = (err: ZodError): TGenericErrorResponse => {
  const errorSources: TErrorSources = err.issues.map((issue) => ({
    path:
      issue.path.length > 0
        ? typeof issue.path[issue.path.length - 1] === 'number'
          ? issue.path.join('.')
          : String(issue.path[issue.path.length - 1])
        : '',
    message: issue.message,
  }));

  return {
    statusCode: httpStatus.BAD_REQUEST,
    message: errorSources.map((e) => e.message).join(', '),
    errorSources,
  };
};

export default handleZodError;
