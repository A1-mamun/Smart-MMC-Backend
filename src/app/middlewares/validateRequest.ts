import catchAsync from '../utils/catchAsync';
import { ZodObject } from 'zod';

const validateRequest = (schema: ZodObject) => {
  return catchAsync(async (req, _res, next) => {
    // Validate (don't transform). `req.query` in this Express setup is a
    // getter that re-parses the URL on every access, so the parsed-and-
    // mutated result of `schema.parseAsync` cannot be persisted onto
    // `req` — the next access returns the raw string values. Transforms
    // therefore must happen in the service layer (see `isTruthyQuery`
    // and `coerceBooleanQuery` helpers there) rather than here.
    //
    // We DO write the parsed body/params because those aren't regenerated
    // by a getter on every access (only `query` is in this Express
    // version).
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