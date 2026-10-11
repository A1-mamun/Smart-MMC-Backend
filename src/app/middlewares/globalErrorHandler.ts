import { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import config from '../config';
import AppError from '../errors/AppError';
import handleZodError from '../errors/handleZodError';
import handleUniqueError from '../errors/handleUniqueError';
import handleRecordNotFoundError from '../errors/handleRecordNotFoundError';
import handleTransactionError from '../errors/handleTransactionError';
import handleForeignKeyError from '../errors/handleForeignKeyError';
import handleValidationError from '../errors/handleValidationError';
import logger from '../utils/logger';
import { TErrorSources } from '../interface/error';

const globalErrorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let statusCode: number = 500;
  let message: string = 'Something went wrong';
  let errorSources: TErrorSources = [{ path: '', message: 'Something went wrong' }];

  if (err instanceof ZodError) {
    const simplified = handleZodError(err);
    statusCode = simplified.statusCode;
    message = simplified.message;
    errorSources = simplified.errorSources;
  } else if (err instanceof PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002':
        const u = handleUniqueError(err);
        statusCode = u.statusCode;
        message = u.message;
        errorSources = u.errorSources;
        break;
      case 'P2025':
        const n = handleRecordNotFoundError(err);
        statusCode = n.statusCode;
        message = n.message;
        errorSources = n.errorSources;
        break;
      case 'P2034':
        const t = handleTransactionError();
        statusCode = t.statusCode;
        message = t.message;
        errorSources = t.errorSources;
        break;
      case 'P2003':
        const f = handleForeignKeyError(err);
        statusCode = f.statusCode;
        message = f.message;
        errorSources = f.errorSources;
        break;
      default:
        const v = handleValidationError(err);
        statusCode = v.statusCode;
        message = v.message;
        errorSources = v.errorSources;
        // _devDetail is only populated for the catch-all Prisma handler;
        // surface it in dev so the toast can show what Prisma actually
        // complained about (missing column, null constraint, etc.).
        if ((v as { _devDetail?: string })._devDetail) {
          (errorSources[0] as { _devDetail?: string })._devDetail = (
            v as { _devDetail?: string }
          )._devDetail;
        }
        break;
    }
  } else if (err instanceof AppError) {
    statusCode = err.statusCode;
    message = err.message;
    errorSources = [{ path: '', message: err.message }];
  } else if (err instanceof Error) {
    statusCode = 500;
    message = err.message;
    errorSources = [{ path: '', message: err.message }];
  }

  // 4xx errors are client-driven (bad input, auth failures, etc.) —
  // their stacks are not actionable and can be large. We log them at
  // `warn` without the stack. 5xx and unexpected errors get the full
  // stack at `error`.
  const isServerError = statusCode >= 500;
  const logPayload = {
    statusCode,
    message,
    errorSources,
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
  };
  if (isServerError) {
    logger.error({ ...logPayload, stack: err?.stack });
  } else {
    logger.warn(logPayload);
  }

  // Treat any value other than the literal string "development" as
  // production. This is deliberately strict — `NODE_ENV=Development`
  // (capital D) or `NODE_ENV=dev` would otherwise fall into the
  // production branch by accident. We want the inverse failure mode:
  // accidentally hiding dev detail is fine, accidentally leaking
  // stack traces is not.
  const isDev = config.node_env === 'development';

  res.status(statusCode).json({
    success: false,
    message,
    errorSources,
    // Dev-only debug metadata: surfaces the Prisma code/meta for the
    // catch-all handler so debugging "Invalid provider data" toasts
    // doesn't require tailing backend logs.
    devDetail: isDev
      ? (errorSources[0] as { _devDetail?: string })._devDetail ?? null
      : null,
    stack: isDev ? err?.stack : null,
  });
};

export default globalErrorHandler;