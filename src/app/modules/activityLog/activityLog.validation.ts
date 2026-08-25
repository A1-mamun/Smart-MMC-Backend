import { z } from 'zod';

const getAllActivitySchema = z.object({
  query: z.object({
    actorId: z.string().uuid().optional(),
    action: z.string().optional(),
    entityType: z.string().optional(),
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
  }),
});

export const ActivityLogValidation = {
  getAllActivitySchema,
};

export type TGetAllActivity = z.infer<typeof getAllActivitySchema>['query'];