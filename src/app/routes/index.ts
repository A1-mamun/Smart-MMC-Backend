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
import { SmsRoutes } from '../modules/sms/sms.route';
import { ExamRoutes } from '../modules/exam/exam.route';
import { SettingsRoutes } from '../modules/settings/settings.route';
import { AbsentWarningRoutes } from '../modules/absentWarning/absentWarning.route';
import { FreeClassRoutes } from '../modules/freeClass/freeClass.route';
import { FreeClassAdminRoutes } from '../modules/freeClass/freeClass.admin.route';

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
  { path: '/sms', route: SmsRoutes },
  { path: '/exam', route: ExamRoutes },
  { path: '/settings', route: SettingsRoutes },
  { path: '/absent-warning', route: AbsentWarningRoutes },
  // Public + student-facing free-class routes (signup/login/content).
  { path: '/free-class', route: FreeClassRoutes },
  // Admin-only free-class CRUD. Mounted under /free-class/admin so the
  // /free-class prefix keeps the related routes grouped in OpenAPI /
  // Postman. The admin handler enforces SUPER_ADMIN/ADMIN roles itself.
  { path: '/free-class/admin', route: FreeClassAdminRoutes },
];

moduleRoutes.forEach((r) => router.use(r.path, r.route));

export default router;