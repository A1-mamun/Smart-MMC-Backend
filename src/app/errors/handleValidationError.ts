import httpStatus from 'http-status';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { TErrorSources, TGenericErrorResponse } from '../interface/error';

const handleValidationError = (
  err?: PrismaClientKnownRequestError,
): TGenericErrorResponse => {
  // Surface the Prisma code/message in dev so debugging the catch-all
  // "Invalid provider data" toast isn't a guessing game. P2002 (unique),
  // P2025 (not found), P2034 (transaction) and P2003 (foreign key) are
  // handled by their dedicated handlers in globalErrorHandler, so anything
  // that lands here is a less-common code (P2022 missing column,
  // P2011 null constraint, etc.). The dev string carries the code; the
  // user-facing toast stays generic so we don't leak internals.
  const code = err?.code;
  const meta = err?.meta as Record<string, unknown> | undefined;
  const detail =
    code && meta
      ? ` (Prisma ${code}: ${Object.entries(meta)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(', ')})`
      : '';

  const errorSources: TErrorSources = [
    { path: '', message: 'Invalid query parameters or provided data.' },
  ];
  return {
    statusCode: httpStatus.BAD_REQUEST,
    message: 'Invalid provider data!',
    errorSources,
    // Surfaced only in dev — see globalErrorHandler's stack branch.
    _devDetail: detail,
  } as TGenericErrorResponse & { _devDetail?: string };
};

export default handleValidationError;