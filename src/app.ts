import cors from 'cors';
import express from 'express';
import cookieParser from 'cookie-parser';
import { v4 as uuidv4 } from 'uuid';
import httpStatus from 'http-status';

import router from './app/routes';
import globalErrorHandler from './app/middlewares/globalErrorHandler';
import notFound from './app/middlewares/notFound';
import morganMiddleware from './app/utils/morgan';
import logger from './app/utils/logger';
import config from './app/config';
import { globalRateLimiter } from './app/middlewares/rateLimiter';

const app = express();

const origins = config
  .frontendUrls!.split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || origins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  }),
);

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Mount the global rate limiter BEFORE per-route limiters and
// business logic so it caps the worst-case abuse per IP across the
// whole API. Per-route limiters (authRateLimiter,
// writeOperationRateLimiter, etc.) are tighter and still apply to
// individual endpoints, but this one is the safety net for anything
// not otherwise capped (e.g. an attacker hammering unauth'd
// /auth/refresh-token trying to brute-force JWTs).
app.use(globalRateLimiter);

app.use((req, _res, next) => {
  req.id = uuidv4();
  next();
});

app.use(morganMiddleware);

app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.originalUrl} - ${req.ip}`);
  next();
});

app.use('/api/v1/', router);

app.get('/', (_req, res) => {
  res.status(httpStatus.OK).json({
    success: true,
    message: 'Smart MMC API is running 🚀',
    version: config.buildVersion,
  });
});

app.get('/health', (_req, res) => {
  // Intentionally minimal — no uptime, timestamp, or version. The
  // /health endpoint is unauthenticated and gives free recon info
  // (when did the server last restart? which build is running?) to
  // anyone fingerprinting the host. Load balancers and uptime
  // monitors only need a 200.
  res.status(httpStatus.OK).json({ success: true, status: 'ok' });
});

app.use(globalErrorHandler);
app.use(notFound);

export default app;
