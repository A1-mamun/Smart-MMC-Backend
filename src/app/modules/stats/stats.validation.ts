import { z } from 'zod';

const admissionComparisonSchema = z.object({
  query: z.object({
    currentBatch: z
      .enum(['BATCH_25', 'BATCH_26', 'BATCH_27', 'BATCH_28'])
      .optional(),
    previousBatch: z
      .enum(['BATCH_25', 'BATCH_26', 'BATCH_27', 'BATCH_28'])
      .optional(),
  }),
});

export const StatsValidation = {
  admissionComparisonSchema,
};

export type TAdmissionComparison = z.infer<typeof admissionComparisonSchema>['query'];