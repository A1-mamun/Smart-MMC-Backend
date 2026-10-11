import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(process.cwd(), '.env') });

// Fail fast at boot if a required secret is missing. Without this, a
// misconfigured production deploy (forgot to set JWT_ACCESS_SECRET
// in .env) would silently accept tokens signed with `undefined` and
// only surface the bug on the first failed verification. Crashing
// at startup is loud and obvious.
const requiredSecret = (name: string, value: string | undefined): string => {
  if (!value || value.length < 16) {
    throw new Error(
      `Required env var ${name} is missing or too short (need >= 16 chars). ` +
        `Refusing to start — set it in your environment or .env file.`,
    );
  }
  return value;
};

export default {
  node_env: process.env.NODE_ENV,
  log_level: process.env.LOG_LEVEL || 'info',
  port: process.env.PORT || 5002,
  database_url: process.env.DATABASE_URL,
  bcryptSaltRounds: process.env.BCRYPT_SALT_ROUNDS,
  jwtAccessSecret: requiredSecret(
    'JWT_ACCESS_SECRET',
    process.env.JWT_ACCESS_SECRET,
  ),
  jwtRefreshSecret: requiredSecret(
    'JWT_REFRESH_SECRET',
    process.env.JWT_REFRESH_SECRET,
  ),
  jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN,
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN,
  frontendUrls: process.env.FRONTEND_URLS,
  redisUrl: process.env.REDIS_URL,
  nodemailerUser: process.env.NODEMAILER_USER,
  nodemailerPass: process.env.NODEMAILER_PASS,
  deviceSecret: process.env.DEVICE_SECRET,
  buildVersion: process.env.BUILD_VERSION || '1',
  // BulkSMSBD.net gateway credentials. Defaults to empty so dev mode
  // never accidentally sends a real SMS.
  bulkSmsApiKey: process.env.BULK_SMS_API_KEY || '',
  bulkSmsSenderId: process.env.BULK_SMS_SENDER_ID || '',
  bulkSmsBaseUrl: process.env.BULK_SMS_BASE_URL || 'http://bulksmsbd.net/api',
  // Cloudinary — used for direct browser uploads of banner images.
  // The API secret signs the upload params; the upload_preset + folder
  // are looked up by name on Cloudinary's side. CLOUDINARY_API_SECRET
  // uses requiredSecret (>= 16 chars) so a misconfigured deploy fails
  // at boot rather than at first upload.
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME,
  cloudinaryApiKey: process.env.CLOUDINARY_API_KEY,
  cloudinaryApiSecret: requiredSecret(
    'CLOUDINARY_API_SECRET',
    process.env.CLOUDINARY_API_SECRET,
  ),
  cloudinaryUploadPreset:
    process.env.CLOUDINARY_UPLOAD_PRESET || 'smart_mmc_banners',
  cloudinaryFolder: process.env.CLOUDINARY_FOLDER || 'smart-mmc/banners',
};