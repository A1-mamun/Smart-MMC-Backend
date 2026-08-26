import { Response } from 'express';

type TMeta = { page: number; limit: number; total: number };

type TSendResponse<T> = {
  statusCode: number;
  success: boolean;
  message: string;
  meta?: TMeta;
  data: T | null | undefined;
  extraData?: Record<string, unknown> | null | undefined;
};

const sendResponse = <T>(res: Response, jsonData: TSendResponse<T>) => {
  res.status(jsonData.statusCode).json({
    success: jsonData.success,
    message: jsonData.message,
    meta: jsonData.meta,
    data: jsonData.data === undefined ? null : jsonData.data,
    extraData: jsonData.extraData,
  });
};

export default sendResponse;
