import { createClient } from 'redis';
import config from '../config';

const redisClient = createClient({
  url: config.redisUrl || 'redis://localhost:6379',
});

redisClient.on('error', (err) => console.log('Redis Client Error:', err));
redisClient.on('connect', () => console.log('Redis Connected Successfully'));

export const connectRedis = async () => {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
};

export default redisClient;
