import httpStatus from 'http-status';
import { Request, Response } from 'express';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import AppError from '../../errors/AppError';
import prisma from '../../utils/prisma';
import { FreeClassAdminService } from './freeClass.admin.service';

/**
 * Express 5 types `req.params` as `string | string[]`; the validation
 * middleware has already constrained it to a string, but TypeScript
 * can't see that. Tiny helper to keep the handlers readable.
 */
const pickParam = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? v[0] : (v as string);

const getAllSubjects = catchAsync(async (_req: Request, res: Response) => {
  const subjects = await FreeClassAdminService.getAllSubjectsForAdmin();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Subjects fetched',
    data: subjects,
  });
});

const listChapters = catchAsync(async (req: Request, res: Response) => {
  const subjectId = req.query.subjectId as string | undefined;
  const chapters = await FreeClassAdminService.listChaptersForAdmin(subjectId);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Chapters fetched',
    data: chapters,
  });
});

const createSubject = catchAsync(async (req: Request, res: Response) => {
  const subject = await FreeClassAdminService.createSubjectToDB(req.body);
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: 'Subject created',
    data: subject,
  });
});

const updateSubject = catchAsync(async (req: Request, res: Response) => {
  const subject = await FreeClassAdminService.updateSubjectToDB(
    pickParam(req.params.id),
    req.body,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Subject updated',
    data: subject,
  });
});

const deleteSubject = catchAsync(async (req: Request, res: Response) => {
  await FreeClassAdminService.deleteSubjectFromDB(pickParam(req.params.id));
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Subject deleted',
    data: null,
  });
});

const createChapter = catchAsync(async (req: Request, res: Response) => {
  const chapter = await FreeClassAdminService.createChapterToDB(
    pickParam(req.params.subjectId),
    req.body,
  );
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: 'Chapter created',
    data: chapter,
  });
});

const updateChapter = catchAsync(async (req: Request, res: Response) => {
  const chapter = await FreeClassAdminService.updateChapterToDB(
    pickParam(req.params.id),
    req.body,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Chapter updated',
    data: chapter,
  });
});

const deleteChapter = catchAsync(async (req: Request, res: Response) => {
  await FreeClassAdminService.deleteChapterFromDB(pickParam(req.params.id));
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Chapter deleted',
    data: null,
  });
});

const createTopic = catchAsync(async (req: Request, res: Response) => {
  const topic = await FreeClassAdminService.createTopicToDB(
    pickParam(req.params.chapterId),
    req.body,
  );
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: 'Topic created',
    data: topic,
  });
});

const updateTopic = catchAsync(async (req: Request, res: Response) => {
  const topic = await FreeClassAdminService.updateTopicToDB(
    pickParam(req.params.id),
    req.body,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Topic updated',
    data: topic,
  });
});

const deleteTopic = catchAsync(async (req: Request, res: Response) => {
  await FreeClassAdminService.deleteTopicFromDB(pickParam(req.params.id));
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Topic deleted',
    data: null,
  });
});

/**
 * Single-step "create free class" endpoint. Admin only chooses the
 * subject dropdown + chapter number + topic title + YouTube URL.
 * Resolves the subject + chapter by name/number, creates the topic,
 * returns the whole branch so the UI can refresh without a follow-up
 * GET.
 */
const createFreeClass = catchAsync(async (req: Request, res: Response) => {
  const result = await FreeClassAdminService.createFreeClassToDB(req.body);
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: 'Free class created',
    data: result,
  });
});

/**
 * Dedicated "create chapter" endpoint (no topic required). Lets the
 * admin scaffold the chapter list before adding videos.
 */
const createChapterOnly = catchAsync(async (req: Request, res: Response) => {
  const result = await FreeClassAdminService.createChapterOnlyToDB(req.body);
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: 'Chapter created',
    data: result,
  });
});

/**
 * Admin preview — returns the playback payload the same way the
 * student /play endpoint does, but works for any topic (including
 * unpublished). Used by the admin UI's preview-from-server action so
 * the admin can sanity-check the embed URL without flipping the
 * isPublished flag.
 */
const previewTopic = catchAsync(async (req: Request, res: Response) => {
  const topic = await prisma.freeTopic.findUnique({ where: { id: pickParam(req.params.id) } });
  if (!topic) {
    throw new AppError(httpStatus.NOT_FOUND, 'Topic not found');
  }
  const playback = FreeClassAdminService.previewTopicPlayback(topic);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Preview fetched',
    data: playback,
  });
});

export const FreeClassAdminController = {
  getAllSubjects,
  listChapters,
  createSubject,
  updateSubject,
  deleteSubject,
  createChapter,
  updateChapter,
  deleteChapter,
  createTopic,
  updateTopic,
  deleteTopic,
  createFreeClass,
  createChapterOnly,
  previewTopic,
};