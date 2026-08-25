import { Router } from 'express';
import { AuthRoutes } from '../modules/auth/auth.route';
import { UserRoutes } from '../modules/user/user.route';
import { StudentRoutes } from '../modules/student/student.route';
import { CourseRoutes } from '../modules/course/course.route';
import { StudentCourseRoutes } from '../modules/studentCourse/studentCourse.route';
import { PaymentRoutes } from '../modules/payment/payment.route';
import { AttendanceRoutes } from '../modules/attendance/attendance.route';
import { DashboardRoutes } from '../modules/dashboard/dashboard.route';
import { ActivityLogRoutes } from '../modules/activityLog/activityLog.route';
import { StatsRoutes } from '../modules/stats/stats.route';

const router = Router();

const moduleRoutes = [
  { path: '/auth', route: AuthRoutes },
  { path: '/user', route: UserRoutes },
  { path: '/student', route: StudentRoutes },
  { path: '/course', route: CourseRoutes },
  { path: '/student-course', route: StudentCourseRoutes },
  { path: '/payment', route: PaymentRoutes },
  { path: '/attendance', route: AttendanceRoutes },
  { path: '/dashboard', route: DashboardRoutes },
  { path: '/activity-log', route: ActivityLogRoutes },
  { path: '/stats', route: StatsRoutes },
];

moduleRoutes.forEach((r) => router.use(r.path, r.route));

export default router;