export const studentFilterableFields = [
  'searchTerm',
  'hscBatch',
  'courseId',
  'courseStatus',
  'batchDay',
  'batchDayId',
  'batchTime',
  'district',
  // SMS scenario filters — must be listed here so the controller's
  // `pick(req.query, studentFilterableFields)` call forwards them to the
  // service. Without this list they are silently dropped at the controller
  // boundary, which is why the bulk-SMS picker used to always show "0
  // match" when these were set.
  'classDate',
  'classTime',
  'scenarioCourses',
  'hasDue',
  // Free-vs-paid segregation. `true` → marketer roster on
  // /dashboard/free-students; `false` → paid dashboard default on
  // /dashboard/students. Without this entry the controller's
  // `pick(req.query, studentFilterableFields)` drops the param at the
  // boundary, the service never sees it, and every student (free + paid)
  // leaks into the free roster page.
  'isFreeAccount',
  // Absent-warning picker — narrows the cohort to students who were
  // expected to be in class on this date but have no Attendance row.
  // Resolved server-side in student.service.ts (see the `absentOnDate`
  // branch in getAllStudentsFromDB); the value is an ISO yyyy-mm-dd.
  'absentOnDate',
];

// `user.studentId` was removed when we migrated the canonical login
// handle to mobile, but the per-enrollment printable handle
// (`StudentCourse.studentCourseId`, e.g. "271200") is still surfaced
// on the Students list and the SMS picker, so admins expect to
// search by it. We resolve it through the `studentCourses` relation
// in the service's OR-clause (see student.service.ts `searchTerm`
// branch in getAllStudentsFromDB).
export const studentSearchableFields = [
  'user.name',
  'user.nickname',
  'mobile',
  'studentCourses.studentCourseId',
];

export { paginationFields } from '../../constant/pagination';
