import redisClient from './redis';

export const clearCacheByPattern = async (pattern: string): Promise<void> => {
  try {
    const keys = await redisClient.keys(pattern);
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
  } catch (error) {
    console.error('Clear cache error:', error);
  }
};

export const clearCache = async (key: string): Promise<void> => {
  try {
    await redisClient.del(key);
  } catch (error) {
    console.error('Clear cache error:', error);
  }
};

export const clearStudentCache = async () => {
  await clearCacheByPattern('cache:/api/v1/student*');
  await clearCacheByPattern('cache:/api/v1/dashboard*');
  await clearCacheByPattern('cache:/api/v1/stats*');
};

export const clearCourseCache = async () => {
  await clearCacheByPattern('cache:/api/v1/course*');
  await clearCacheByPattern('cache:/api/v1/student-course*');
};

export const clearPaymentCache = async () => {
  await clearCacheByPattern('cache:/api/v1/payment*');
  await clearCacheByPattern('cache:/api/v1/dashboard*');
  await clearCacheByPattern('cache:/api/v1/student*');
  await clearCacheByPattern('cache:/api/v1/stats*');
};

export const clearAttendanceCache = async () => {
  await clearCacheByPattern('cache:/api/v1/attendance*');
  await clearCacheByPattern('cache:/api/v1/dashboard*');
};

export const clearUserCache = async () => {
  await clearCacheByPattern('cache:/api/v1/user*');
};