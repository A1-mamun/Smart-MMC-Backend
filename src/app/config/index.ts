import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(process.cwd(), '.env') });

export default {
  node_env: process.env.NODE_ENV,
  log_level: process.env.LOG_LEVEL || 'info',
  port: process.env.PORT || 5002,
  database_url: process.env.DATABASE_URL,
  bcryptSaltRounds: process.env.BCRYPT_SALT_ROUNDS,
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
  jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN,
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN,
  frontendUrls: process.env.FRONTEND_URLS,
  redisUrl: process.env.REDIS_URL,
  nodemailerUser: process.env.NODEMAILER_USER,
  nodemailerPass: process.env.NODEMAILER_PASS,
  deviceSecret: process.env.DEVICE_SECRET,
  buildVersion: process.env.BUILD_VERSION || '1',
};