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

const app = express();

const origins = (config.frontendUrls || 'http://localhost:3000').split(',').map((o) => o.trim());

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
  res.status(httpStatus.OK).json({
    success: true,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.use(globalErrorHandler);
app.use(notFound);

export default app;
