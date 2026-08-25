import { RequestHandler } from 'express';
import httpStatus from 'http-status';

const notFound: RequestHandler = (req, res) => {
  res.status(httpStatus.NOT_FOUND).json({
    success: false,
    message: 'Api Not Found!',
    error: '',
    path: req.originalUrl,
  });
};

export default notFound;