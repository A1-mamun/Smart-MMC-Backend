import catchAsync from '../utils/catchAsync';
import { ZodObject } from 'zod';

const validateRequest = (schema: ZodObject) => {
  return catchAsync(async (req, _res, next) => {
    await schema.parseAsync({
      body: req.body,
      cookies: req.cookies,
      // files: req.files,
      params: req.params,
      query: req.query,
    });
    next();
  });
};

export default validateRequest;
