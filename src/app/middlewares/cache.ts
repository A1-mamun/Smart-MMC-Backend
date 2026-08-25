import { RequestHandler } from 'express';
import redisClient from '../utils/redis';

export const cache = (duration: number = 300): RequestHandler => {
  return async (req, res, next) => {
    if (req.method !== 'GET') return next();
    const key = `cache:${req.originalUrl}`;
    try {
      const cachedData = await redisClient.get(key);
      if (cachedData) {
        return res.status(200).json(JSON.parse(cachedData));
      }
      const originalJson = res.json.bind(res);
      res.json = (data: unknown) => {
        redisClient
          .setEx(key, duration, JSON.stringify(data))
          .catch((err) => console.error('Cache set error:', err));
        return originalJson(data);
      };
      next();
    } catch {
      next();
    }
  };
};