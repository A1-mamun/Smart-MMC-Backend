import morgan, { StreamOptions } from 'morgan';
import logger from './logger';
import config from '../config';

const stream: StreamOptions = {
  write: (message: string) => logger.http(message.trim()),
};

const skip = () => config.node_env === 'test';

const morganMiddleware = morgan(
  ':method :url :status :res[content-length] - :response-time ms',
  { stream, skip },
);

export default morganMiddleware;