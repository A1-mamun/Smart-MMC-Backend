import httpStatus from 'http-status';
import { TErrorSources, TGenericErrorResponse } from '../interface/error';

const handleValidationError = (): TGenericErrorResponse => {
  const errorSources: TErrorSources = [
    { path: '', message: 'Invalid query parameters or provided data.' },
  ];
  return {
    statusCode: httpStatus.BAD_REQUEST,
    message: 'Invalid provider data!',
    errorSources,
  };
};

export default handleValidationError;