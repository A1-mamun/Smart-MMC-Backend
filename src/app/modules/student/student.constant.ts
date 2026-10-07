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
  'activeCoursesOnly',
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
// handle to mobile. The per-enrollment `studentCourse.studentCourseId`
// is the printable handle on receipts, not a single global string on
// User — so it doesn't make sense to search by it here. Admins search
// by name / nickname / mobile, all of which are surfaced on the
// students list.
export const studentSearchableFields = ['user.name', 'user.nickname', 'mobile'];

export { paginationFields } from '../../constant/pagination';
