import { z } from 'zod';

const getAllActivitySchema = z.object({
  query: z.object({
    actorId: z.string().uuid().optional(),
    action: z.string().optional(),
    entityType: z.string().optional(),
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
    // Case-insensitive search across the human-readable columns of the
    // activity log: the action verb (e.g. "RECORD_PAYMENT"), the entity
    // type (e.g. "Payment"), the entity's UUID, and the rendered
    // `description` string. Metadata is JSON and intentionally not
    // searched — admins read it via the detail row when needed.
    searchTerm: z.string().trim().min(1).max(100).optional(),
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