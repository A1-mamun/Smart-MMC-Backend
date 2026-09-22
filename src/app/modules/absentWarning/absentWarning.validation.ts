import { z } from 'zod';

/**
 * Validation for the manual "absent on date" picker (used by the SMS
 * panel's "Absent on date" filter) and for the ad-hoc "Run now"
 * trigger. The picker takes a date and returns the list of students
 * who were enrolled in a class on that date but have no Attendance
 * row, so the admin can pick the recipients, type a message, and
 * click Send on /dashboard/sms.
 */
const pickerSchema = z.object({
  query: z.object({
    // ISO yyyy-mm-dd. Caller-side cap is "today" (you can't be
    // absent in the future); the service defensively clamps as well.
    date: z.coerce.date(),
  }),
});

export const AbsentWarningValidation = {
  pickerSchema,
};

export type TPickerQuery = z.infer<typeof pickerSchema>['query'];
