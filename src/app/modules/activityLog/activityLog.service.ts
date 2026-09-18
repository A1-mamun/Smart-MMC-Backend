import { Prisma } from '@prisma/client';
import prisma from '../../utils/prisma';
import calculatePagination from '../../utils/calculatePagination';
import { TGetAllActivity } from './activityLog.validation';

const getAllActivitiesFromDB = async (filters: TGetAllActivity) => {
  const { page, limit, skip, sortBy, sortOrder } = calculatePagination(filters);
  const { searchTerm, ...rest } = filters;
  const where: Prisma.ActivityLogWhereInput = {};
  if (rest.actorId) where.actorId = rest.actorId;
  if (rest.action) where.action = rest.action;
  if (rest.entityType) where.entityType = rest.entityType;
  if (rest.startDate || rest.endDate) {
    where.createdAt = {
      ...(rest.startDate ? { gte: rest.startDate } : {}),
      ...(rest.endDate ? { lte: rest.endDate } : {}),
    };
  }
  // Case-insensitive OR search over the four human-readable columns.
  // `entityId` is included so an admin can paste a UUID from another tab
  // and find the matching event; UUIDs are paged in batches so the lookup
  // stays cheap with the index on `entityType`/`action`.
  if (searchTerm) {
    where.OR = [
      { description: { contains: searchTerm, mode: 'insensitive' } },
      { action: { contains: searchTerm, mode: 'insensitive' } },
      { entityType: { contains: searchTerm, mode: 'insensitive' } },
      { entityId: { contains: searchTerm, mode: 'insensitive' } },
    ];
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