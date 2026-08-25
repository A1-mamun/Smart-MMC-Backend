import { Prisma } from '@prisma/client';
import prisma from '../../utils/prisma';
import calculatePagination from '../../utils/calculatePagination';
import { TGetAllActivity } from './activityLog.validation';

const getAllActivitiesFromDB = async (filters: TGetAllActivity) => {
  const { page, limit, skip, sortBy, sortOrder } = calculatePagination(filters);
  const where: Prisma.ActivityLogWhereInput = {};
  if (filters.actorId) where.actorId = filters.actorId;
  if (filters.action) where.action = filters.action;
  if (filters.entityType) where.entityType = filters.entityType;
  if (filters.startDate || filters.endDate) {
    where.createdAt = {
      ...(filters.startDate ? { gte: filters.startDate } : {}),
      ...(filters.endDate ? { lte: filters.endDate } : {}),
    };
  }

  const orderBy: Prisma.ActivityLogOrderByWithRelationInput = sortBy
    ? ({ [sortBy]: sortOrder } as Prisma.ActivityLogOrderByWithRelationInput)
    : { createdAt: 'desc' };

  const [data, total] = await Promise.all([
    prisma.activityLog.findMany({
      where,
      skip,
      take: limit,
      orderBy,
    }),
    prisma.activityLog.count({ where }),
  ]);

  return { data, meta: { page, limit, total } };
};

const getRecentActivitiesFromDB = async (limit: number = 10) => {
  return prisma.activityLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
};

export const ActivityLogService = {
  getAllActivitiesFromDB,
  getRecentActivitiesFromDB,
};