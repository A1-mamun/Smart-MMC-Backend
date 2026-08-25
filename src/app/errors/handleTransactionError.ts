import httpStatus from 'http-status';
import { TErrorSources, TGenericErrorResponse } from '../interface/error';

const handleTransactionError = (): TGenericErrorResponse => {
  const errorSources: TErrorSources = [
    {
      path: '',
      message: 'Transaction failed due to write conflict or deadlock. Please try again.',
    },
  ];
  return {
    statusCode: httpStatus.CONFLICT,
    message: 'Failed to update data! Please try again.',
    errorSources,
  };
};

export default handleTransactionError;