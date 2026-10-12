import catchAsync from '../utils/catchAsync';
// Accept any Zod schema (object, effects, refined, etc.). The
// middleware only ever calls `.parseAsync(...)` on it, which is
// defined on the base `ZodType`. The old `ZodObject` typing
// rejected schemas that wrapped the object in `.superRefine`
// (returning a `ZodEffects`), even though those schemas expose
// the same `parseAsync` API.
import type { ZodTypeAny } from 'zod';

const validateRequest = (schema: ZodTypeAny) => {
  return catchAsync(async (req, _res, next) => {
    // Validate (don't transform). `req.query` in this Express setup is a
    // getter that re-parses the URL on every access, so the parsed-and-
    // mutated result of `schema.parseAsync` cannot be persisted onto
    // `req` — the next access returns the raw string values. Transforms
    // for query params therefore must happen in the service layer (see
    // `isTruthyQuery` and `coerceBooleanQuery` helpers there) rather
    // than here.
    //
    // We DO write the parsed body/params because those aren't regenerated
    // by a getter on every access (only `query` is in this Express
    // version). Writing them back matters because Zod's `.coerce.*`
    // transforms (e.g. `z.coerce.date()` on a YYYY-MM-DD string from an
    // HTML `<input type="date">`) only happen during parsing — without
    // assigning the result back, the raw string reaches Prisma and the
    // DB driver rejects it as "premature end of input".
    const parsed = await schema.parseAsync({
      body: req.body,
      cookies: req.cookies,
      // files: req.files,
      params: req.params,
      query: req.query,
    });
    // `parsed` is a partial of the original — only the keys the schema
    // defined. Assign body and params back; leave `query` alone because
    // it's a getter that re-parses anyway.
    if (parsed && typeof parsed === 'object') {
      if ('body' in parsed && parsed.body !== undefined) {
        req.body = parsed.body;
      }
      if ('params' in parsed && parsed.params !== undefined) {
        // Object.assign so we don't lose keys Express itself owns
        // (e.g. route params from upstream middleware).
        Object.assign(req.params, parsed.params);
      }
    }

    next();
  });
};

export default validateRequest;