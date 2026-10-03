import express from 'express';
import validateRequest from '../../middlewares/validateRequest';
import Auth from '../../middlewares/auth';
import { USER_ROLE } from '../../constant/userConstant';
import { writeOperationRateLimiter } from '../../middlewares/rateLimiter';
import { FreeClassAdminValidation } from './freeClass.admin.validation';
import { FreeClassAdminController } from './freeClass.admin.controller';

const router = express.Router();

// All admin endpoints require SUPER_ADMIN or ADMIN.
const adminGuard = Auth(USER_ROLE.SUPER_ADMIN, USER_ROLE.ADMIN);

// ─── Subjects ──────────────────────────────────────────────────────────────
router.get('/subjects', adminGuard, FreeClassAdminController.getAllSubjects);

// ─── Chapters list (used by the create-class modal's chapter picker) ──
router.get(
  '/chapters',
  adminGuard,
  validateRequest(FreeClassAdminValidation.listChaptersSchema),
  FreeClassAdminController.listChapters,
);

router.post(
  '/subjects',
  adminGuard,
  writeOperationRateLimiter,
  validateRequest(FreeClassAdminValidation.createSubjectSchema),
  FreeClassAdminController.createSubject,
);

router.patch(
  '/subjects/:id',
  adminGuard,
  validateRequest(FreeClassAdminValidation.idParam),
  validateRequest(FreeClassAdminValidation.updateSubjectSchema),
  FreeClassAdminController.updateSubject,
);

router.delete(
  '/subjects/:id',
  adminGuard,
  validateRequest(FreeClassAdminValidation.idParam),
  FreeClassAdminController.deleteSubject,
);

// ─── Chapters ──────────────────────────────────────────────────────────────
router.post(
  '/subjects/:subjectId/chapters',
  adminGuard,
  writeOperationRateLimiter,
  validateRequest(FreeClassAdminValidation.subjectIdParam),
  validateRequest(FreeClassAdminValidation.createChapterSchema),
  FreeClassAdminController.createChapter,
);

router.patch(
  '/chapters/:id',
  adminGuard,
  validateRequest(FreeClassAdminValidation.idParam),
  validateRequest(FreeClassAdminValidation.updateChapterSchema),
  FreeClassAdminController.updateChapter,
);

router.delete(
  '/chapters/:id',
  adminGuard,
  validateRequest(FreeClassAdminValidation.idParam),
  FreeClassAdminController.deleteChapter,
);

// ─── Topics ────────────────────────────────────────────────────────────────
// Single-step "create free class" flow: subject + chapter number + topic +
// YouTube URL. Resolves subject + chapter by name/number, creates the
// topic, returns the whole branch.
router.post(
  '/topics/create',
  adminGuard,
  writeOperationRateLimiter,
  validateRequest(FreeClassAdminValidation.createFreeClassSchema),
  FreeClassAdminController.createFreeClass,
);

// Dedicated "create chapter" (no topic) — scaffolds the chapter list
// before the admin starts dropping videos in.
router.post(
  '/chapters/create',
  adminGuard,
  writeOperationRateLimiter,
  validateRequest(FreeClassAdminValidation.createChapterOnlySchema),
  FreeClassAdminController.createChapterOnly,
);

router.post(
  '/chapters/:chapterId/topics',
  adminGuard,
  writeOperationRateLimiter,
  validateRequest(FreeClassAdminValidation.chapterIdParam),
  validateRequest(FreeClassAdminValidation.createTopicSchema),
  FreeClassAdminController.createTopic,
);

router.patch(
  '/topics/:id',
  adminGuard,
  validateRequest(FreeClassAdminValidation.idParam),
  validateRequest(FreeClassAdminValidation.updateTopicSchema),
  FreeClassAdminController.updateTopic,
);

router.delete(
  '/topics/:id',
  adminGuard,
  validateRequest(FreeClassAdminValidation.idParam),
  FreeClassAdminController.deleteTopic,
);

// Admin preview — returns the same playback payload the student sees,
// so admins can sanity-check that the embed URL works before publishing.
// Admin → any topic (even unpublished), student → published only.
router.post(
  '/topics/:id/play',
  adminGuard,
  validateRequest(FreeClassAdminValidation.topicIdParam),
  FreeClassAdminController.previewTopic,
);

export const FreeClassAdminRoutes = router;