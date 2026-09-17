import { z } from 'zod';

const smsModes = ['ONE_TO_ONE', 'ONE_TO_MANY'] as const;

/**
 * Each recipient is the bare minimum needed by the gateway and the audit
 * log. `studentId` is the Student.id (UUID) — used so the activity log
 * can attach the SMS to a real student record if we ever want to look up
 * "messages sent to student X". `name` and `mobile` are sent as-is so the
 * frontend doesn't have to refetch them.
 */
const recipientSchema = z.object({
  studentId: z.string(),
  name: z.string(),
  mobile: z.string(),
});

const sendSmsSchema = z.object({
  body: z.object({
    mode: z.enum(smsModes),
    recipients: z.array(recipientSchema).min(1).max(500),
    // 1600 chars lets staff send multi-part SMS without worrying about
    // per-segment limits. The gateway itself enforces the actual cap.
    message: z.string().min(1).max(1600),
  }),
});

const getMyLogsSchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
});

export const SmsValidation = {
  sendSmsSchema,
  getMyLogsSchema,
};

export type TSendSms = z.infer<typeof sendSmsSchema>['body'];
export type TGetMyLogs = z.infer<typeof getMyLogsSchema>['query'];
