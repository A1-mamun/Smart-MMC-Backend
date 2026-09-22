import httpStatus from 'http-status';
import { Prisma } from '@prisma/client';
import prisma from '../../utils/prisma';
import AppError from '../../errors/AppError';
import calculatePagination from '../../utils/calculatePagination';
import { JwtPayload } from 'jsonwebtoken';
import {
  TCreateExam,
  TUpdateExam,
  TSetPublish,
  TUpsertRoster,
  TSetAttendance,
  TBulkAttendanceByStudentId,
  TUpsertResult,
  TBulkResults,
  TListExams,
  TGetMyResults,
  TGetMyUpcomingExams,
} from './exam.validation';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Treat truthy query values uniformly. The validateRequest middleware
 * validates the parsed Zod result and discards it, so the raw URL-encoded
 * string ("true" / "1") reaches the service even though the schema's
 * *output* type is `boolean`. Without this coercion, `isResultPublished`
 * arrives as `"true"` / `"false"` / `undefined` and the strict equality
 * `isResultPublished === true` would silently never match — the same trap
 * that bit `hasDue` / `activeCoursesOnly` in student.service.ts.
 */
const isTruthyQuery = (v: unknown): boolean =>
  v === true || v === 'true' || v === '1' || v === 1;

/**
 * Build the section payload for a Prisma `createMany`. Computes `totalMarks`
 * as `totalQuestions * marksPerQuestion` so the denormalised total on `Exam`
 * stays in sync. Position defaults to its array index.
 */
const buildSectionCreateRows = (
  examId: string,
  sections: TCreateExam['sections'],
): Prisma.ExamSectionCreateManyInput[] =>
  sections.map((s, idx) => ({
    examId,
    type: s.type,
    name: s.name.trim(),
    totalQuestions: s.totalQuestions,
    marksPerQuestion: new Prisma.Decimal(s.marksPerQuestion),
    totalMarks: Math.round(s.totalQuestions * s.marksPerQuestion),
    position: s.position ?? idx,
  }));

/**
 * Compute SQL `RANK()` for every non-absent result of an exam, then update
 * each row's `rank` column. Uses `RANK()` (not `DENSE_RANK`) so two tied
 * students share rank N and the next student jumps to N+2 — matches the
 * user's stated expectation ("if highest mark got by two students then
 * both of them rank as first").
 */
const recomputeRanks = async (examId: string, tx: Prisma.TransactionClient) => {
  // UUIDs only contain `[0-9a-f-]`, so it's safe to interpolate the value
  // directly into the SQL string rather than binding it as a parameter.
  // We previously used a tagged-template form `${examId}::uuid`, but Prisma's
  // `$executeRaw` tagged templates send parameters as bound values whose
  // Postgres type is inferred as `text` — so `WHERE "examId" = $1::uuid`
  // becomes `text = uuid` and Postgres rejects it.
  //
  // The `examId` column itself is also `text` (the Prisma schema declares
  // these FKs as plain `String`, so Postgres stores them as `text`, not
  // `uuid`), so we must NOT cast the right-hand side to `uuid` either —
  // that's exactly the mismatch the original cast introduced. We compare
  // text-to-text and rely on the regex guard below to keep the literal safe.
  if (!/^[0-9a-f-]{36}$/i.test(examId)) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Invalid examId for ranking');
  }
  await tx.$executeRawUnsafe(
    `UPDATE "exam_results" er
       SET "rank" = ranked.rk
       FROM (
         SELECT id,
                RANK() OVER (ORDER BY "obtainedMarks" DESC, "updatedAt" ASC) AS rk
         FROM "exam_results"
         WHERE "examId" = '${examId}' AND "isAbsent" = false
       ) AS ranked
       WHERE er.id = ranked.id`,
  );
  // Clear rank for any absent student that may have had a stale value.
  await tx.examResult.updateMany({
    where: { examId, isAbsent: true },
    data: { rank: null },
  });
};

/**
 * Recompute `ExamResult.obtainedMarks` as the sum of its section marks.
 */
const recomputeResultTotal = async (
  resultId: string,
  tx: Prisma.TransactionClient,
): Promise<number> => {
  const agg = await tx.examResultSection.aggregate({
    where: { resultId },
    _sum: { obtainedMarks: true },
  });
  const total = agg._sum.obtainedMarks ?? 0;
  await tx.examResult.update({
    where: { id: resultId },
    data: { obtainedMarks: total },
  });
  return total;
};

/**
 * Decide whether a result row counts as "marks entered". True when ANY
 * per-section mark is > 0, OR any section has correctAnswers / notes,
 * OR the top-level remarks is non-empty.
 *
 * The "attended but scored 0 in every section" case is treated as entered
 * ONLY when the admin also added at least one of: correctAnswers, notes,
 * or remarks. Otherwise the save is a no-op for `marksEntered` (e.g. the
 * admin pressed Save on a row where they typed nothing) — we deliberately
 * leave the flag false in that case so publish is still blocked.
 */
type TEnteredSectionInput = {
  obtainedMarks: number;
  correctAnswers: number | null;
  notes: string | null;
};

const resultHasMarksEntered = (
  sections: TEnteredSectionInput[],
  remarks: string | null,
): boolean => {
  if (remarks && remarks.trim() !== '') return true;
  return sections.some((s) => {
    if (s.obtainedMarks > 0) return true;
    if (s.correctAnswers !== null && s.correctAnswers !== undefined)
      return true;
    if (s.notes !== null && s.notes.trim() !== '') return true;
    return false;
  });
};

// ────────────────────────────────────────────────────────────────────────────
// Create / update
// ────────────────────────────────────────────────────────────────────────────

const createExamToDB = async (payload: TCreateExam, user: JwtPayload) => {
  // The validateRequest middleware validates the parsed Zod result but
  // discards it, so `req.body` retains the raw JSON-typed shape the client
  // sent: `examDate` arrives as a string (e.g. "2026-09-20"), and
  // `totalQuestions` / `marksPerQuestion` inside each section may arrive as
  // strings too. Prisma rejects raw date strings for `@db.Date` columns
  // with "premature end of input", and integer fields get coerced to 0 if
  // we don't normalise. Convert everything up-front so the rest of this
  // function can trust its inputs.
  const examDate =
    payload.examDate instanceof Date
      ? payload.examDate
      : new Date(payload.examDate);
  if (Number.isNaN(examDate.getTime())) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Invalid examDate');
  }
  // Reject past dates. `examDate` is a @db.Date (no time component), so we
  // compare on the day boundary using the server's local "today". An exam
  // scheduled for *today* is still allowed — only strictly earlier days are
  // blocked, since you can't usefully create an exam that's already
  // happened.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const examDay = new Date(examDate);
  examDay.setHours(0, 0, 0, 0);
  if (examDay.getTime() < today.getTime()) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'examDate cannot be in the past',
    );
  }
  const sections = payload.sections.map((s, idx) => ({
    type: s.type,
    name: s.name.trim(),
    totalQuestions: Number(s.totalQuestions),
    marksPerQuestion: Number(s.marksPerQuestion),
    position: s.position != null ? Number(s.position) : idx,
  }));
  for (const s of sections) {
    if (!Number.isFinite(s.totalQuestions) || s.totalQuestions < 1) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Section "${s.name}" has invalid totalQuestions`,
      );
    }
    if (!Number.isFinite(s.marksPerQuestion) || s.marksPerQuestion < 0) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Section "${s.name}" has invalid marksPerQuestion`,
      );
    }
  }

  // 1. Verify course is active and not soft-deleted.
  const course = await prisma.course.findFirst({
    where: { id: payload.courseId, isActive: true, isDeleted: false },
  });
  if (!course) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Selected course is not available for exams (inactive or archived)',
    );
  }

  // 2. Reject duplicate section names within the same exam (case-insensitive).
  const names = sections.map((s) => s.name.toLowerCase());
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length > 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Duplicate section names: ${Array.from(new Set(dupes)).join(', ')}`,
    );
  }

  return prisma.$transaction(async (tx) => {
    const totalMarks = sections.reduce(
      (acc, s) => acc + Math.round(s.totalQuestions * s.marksPerQuestion),
      0,
    );

    const exam = await tx.exam.create({
      data: {
        title: payload.title.trim(),
        syllabus: payload.syllabus,
        examDate,
        courseId: course.id,
        totalMarks,
        createdById: user.userId,
      },
    });

    await tx.examSection.createMany({
      data: buildSectionCreateRows(exam.id, sections),
    });
    const createdSections = await tx.examSection.findMany({
      where: { examId: exam.id },
      orderBy: { position: 'asc' },
    });

    // 3. Materialise initial roster from active enrollments.
    const enrollments = await tx.studentCourse.findMany({
      where: { courseId: course.id, isDeleted: false },
      select: { studentId: true },
    });

    if (enrollments.length > 0) {
      await tx.examResult.createMany({
        data: enrollments.map((e) => ({
          examId: exam.id,
          studentId: e.studentId,
          // Roster starts as ABSENT. The admin marks students PRESENT via
          // the Examinees tab (barcode scanner or manual Switch) on the day
          // of the exam — we never assume someone has shown up at exam
          // creation time.
          isAbsent: true,
          obtainedMarks: 0,
        })),
      });

      const results = await tx.examResult.findMany({
        where: { examId: exam.id },
        select: { id: true, studentId: true },
      });

      // One ExamResultSection row per (result × section), all zeros; admins
      // will fill these via the Results tab.
      const sectionRows: Prisma.ExamResultSectionCreateManyInput[] = [];
      for (const r of results) {
        for (const s of createdSections) {
          sectionRows.push({
            resultId: r.id,
            sectionId: s.id,
            obtainedMarks: 0,
          });
        }
      }
      if (sectionRows.length > 0) {
        await tx.examResultSection.createMany({ data: sectionRows });
      }
    }

    await tx.activityLog.create({
      data: {
        actorId: user.userId,
        actorRole: user.role as 'SUPER_ADMIN' | 'ADMIN',
        action: 'EXAM_CREATED',
        entityType: 'Exam',
        entityId: exam.id,
        description: `Exam "${exam.title}" created for ${course.name}`,
        metadata: {
          courseId: course.id,
          courseName: course.name,
          totalMarks,
          sectionCount: createdSections.length,
          rosterSize: enrollments.length,
        },
      },
    });

    return tx.exam.findUnique({
      where: { id: exam.id },
      include: { sections: { orderBy: { position: 'asc' } } },
    });
  });
};

const updateExamToDB = async (
  id: string,
  payload: TUpdateExam['body'],
  user: JwtPayload,
) => {
  // Normalise examDate + numeric fields from the raw request body (same
  // reason as `createExamToDB` — validateRequest discards the parsed Zod
  // result).
  const examDateUpdate =
    payload.examDate === undefined || payload.examDate === null
      ? undefined
      : payload.examDate instanceof Date
        ? payload.examDate
        : new Date(payload.examDate);
  if (examDateUpdate && Number.isNaN(examDateUpdate.getTime())) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Invalid examDate');
  }
  // Past-date guard happens inside the transaction below — we need to
  // compare against `existing.examDate` so that submitting the existing
  // (unchanged) past date is a no-op rather than a rejection.
  const incomingSections = payload.sections?.map((s, idx) => ({
    id: s.id,
    type: s.type,
    name: s.name.trim(),
    totalQuestions: Number(s.totalQuestions),
    marksPerQuestion: Number(s.marksPerQuestion),
    position: s.position != null ? Number(s.position) : idx,
  }));

  const existing = await prisma.exam.findUnique({
    where: { id },
    include: { sections: { include: { resultSections: true } } },
  });
  if (!existing) {
    throw new AppError(httpStatus.NOT_FOUND, 'Exam not found');
  }
  if (existing.isResultPublished) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Cannot edit an exam whose results are already published',
    );
  }

  return prisma.$transaction(async (tx) => {
    const meta: Prisma.ExamUpdateInput = {};
    if (payload.title !== undefined) meta.title = payload.title.trim();
    if (payload.syllabus !== undefined) meta.syllabus = payload.syllabus;
    if (examDateUpdate) {
      // Past-date guard: reject if the new date is strictly before today
      // AND differs from the existing date. Submitting the existing date
      // back unchanged is a no-op (e.g. admin is editing the syllabus only
      // on an exam whose date is already today/past). This mirrors the
      // create-side guard and keeps the date the same way the user
      // expects.
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const newDay = new Date(examDateUpdate);
      newDay.setHours(0, 0, 0, 0);
      const existingDay = new Date(existing.examDate);
      existingDay.setHours(0, 0, 0, 0);
      const isSameDate = newDay.getTime() === existingDay.getTime();
      if (!isSameDate && newDay.getTime() < today.getTime()) {
        throw new AppError(
          httpStatus.BAD_REQUEST,
          'examDate cannot be in the past',
        );
      }
      meta.examDate = examDateUpdate;
    }
    if (payload.courseId !== undefined) {
      const course = await tx.course.findFirst({
        where: { id: payload.courseId, isActive: true, isDeleted: false },
      });
      if (!course) {
        throw new AppError(
          httpStatus.BAD_REQUEST,
          'Selected course is not available for exams',
        );
      }
      meta.course = { connect: { id: course.id } };

      // Roster reseeding — fires only on a *real* course change (not when
      // the admin re-submits the same courseId on an unrelated edit).
      // Without this, an exam originally created for a course with zero
      // enrolled students (e.g. ADMISSION before any enrolments exist)
      // would stay empty forever after the course is swapped.
      //
      // We ADD missing students; we never remove existing roster entries.
      // If the admin wants to drop students from the previous course they
      // can use the dedicated `upsertRoster` endpoint. We can't blanket-
      // wipe on course change because doing so would silently destroy
      // already-entered attendance + marks for anyone who overlaps between
      // the two courses.
      //
      // New roster rows start ABSENT and carry zeroed section rows — same
      // contract as `createExamToDB` and `upsertRosterToDB`. We rely on
      // the `existing.isResultPublished === false` guard at the top of
      // `updateExamToDB` so we don't have to re-check here.
      if (existing.courseId !== course.id) {
        const enrolled = await tx.studentCourse.findMany({
          where: { courseId: course.id, isDeleted: false },
          select: { studentId: true },
        });
        const enrolledIds = enrolled.map((e) => e.studentId);

        // Skip the creation pass entirely if the new course has no one
        // enrolled — matches `createExamToDB`'s behaviour for a brand-new
        // empty course.
        if (enrolledIds.length > 0) {
          const alreadyOnRoster = await tx.examResult.findMany({
            where: { examId: id, studentId: { in: enrolledIds } },
            select: { studentId: true },
          });
          const onRoster = new Set(alreadyOnRoster.map((r) => r.studentId));
          const fresh = enrolledIds.filter((sid) => !onRoster.has(sid));

          if (fresh.length > 0) {
            await tx.examResult.createMany({
              data: fresh.map((studentId) => ({
                examId: id,
                studentId,
                // Same rule as create / roster-add: newly-seeded roster
                // members start ABSENT and need to be flipped PRESENT
                // via the Examinees tab on the day of the exam.
                isAbsent: true,
                obtainedMarks: 0,
              })),
            });

            // One ExamResultSection row per (new result × existing
            // section), all zeros — admins fill via the Results tab.
            // `existing.sections` was loaded with the exam above.
            const sectionIds = existing.sections.map((s) => s.id);
            const newResults = await tx.examResult.findMany({
              where: { examId: id, studentId: { in: fresh } },
              select: { id: true },
            });
            const rows: Prisma.ExamResultSectionCreateManyInput[] = [];
            for (const r of newResults) {
              for (const sid of sectionIds) {
                rows.push({ resultId: r.id, sectionId: sid, obtainedMarks: 0 });
              }
            }
            if (rows.length > 0) {
              await tx.examResultSection.createMany({ data: rows });
            }
          }
        }
      }
    }

    if (incomingSections) {
      // Reject deleting a section that already carries marks.
      const incomingIds = new Set(
        incomingSections.filter((s) => s.id).map((s) => s.id as string),
      );
      const dropped = existing.sections.filter((s) => !incomingIds.has(s.id));
      for (const d of dropped) {
        const hasMarks = d.resultSections.some((rs) => rs.obtainedMarks > 0);
        if (hasMarks) {
          throw new AppError(
            httpStatus.BAD_REQUEST,
            `Cannot remove section "${d.name}" because students already have marks entered`,
          );
        }
      }

      // Reject duplicate section names within the new list.
      const names = incomingSections.map((s) => s.name.toLowerCase());
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      if (dupes.length > 0) {
        throw new AppError(
          httpStatus.BAD_REQUEST,
          `Duplicate section names: ${Array.from(new Set(dupes)).join(', ')}`,
        );
      }

      // Apply: delete dropped, update existing-by-id, create new.
      await tx.examSection.deleteMany({
        where: { id: { in: dropped.map((d) => d.id) } },
      });

      for (const s of incomingSections) {
        if (s.id) {
          await tx.examSection.update({
            where: { id: s.id },
            data: {
              type: s.type,
              name: s.name,
              totalQuestions: s.totalQuestions,
              marksPerQuestion: new Prisma.Decimal(s.marksPerQuestion),
              totalMarks: Math.round(s.totalQuestions * s.marksPerQuestion),
              position: s.position ?? 0,
            },
          });
        }
      }
      const newOnes = incomingSections.filter((s) => !s.id);
      if (newOnes.length > 0) {
        const created = await tx.examSection.createMany({
          data: buildSectionCreateRows(id, newOnes),
        });
        if (created.count > 0) {
          const newSectionIds = await tx.examSection.findMany({
            where: {
              examId: id,
              name: { in: newOnes.map((s) => s.name) },
            },
            select: { id: true },
          });
          const results = await tx.examResult.findMany({
            where: { examId: id },
            select: { id: true },
          });
          const rows: Prisma.ExamResultSectionCreateManyInput[] = [];
          for (const r of results) {
            for (const sid of newSectionIds) {
              rows.push({ resultId: r.id, sectionId: sid.id, obtainedMarks: 0 });
            }
          }
          if (rows.length > 0) {
            await tx.examResultSection.createMany({ data: rows });
          }
        }
      }

      // Recompute denormalised totalMarks.
      const allSec = await tx.examSection.findMany({ where: { examId: id } });
      meta.totalMarks = allSec.reduce((acc, s) => acc + s.totalMarks, 0);
    }

    const updated = await tx.exam.update({ where: { id }, data: meta });
    await tx.activityLog.create({
      data: {
        actorId: user.userId,
        actorRole: user.role as 'SUPER_ADMIN' | 'ADMIN',
        action: 'EXAM_UPDATED',
        entityType: 'Exam',
        entityId: id,
        description: `Exam "${updated.title}" updated`,
        metadata: { changed: Object.keys(payload) },
      },
    });
    return updated;
  });
};

// ────────────────────────────────────────────────────────────────────────────
// Publish / unpublish (with ranking)
// ────────────────────────────────────────────────────────────────────────────

const setExamPublishToDB = async (
  id: string,
  payload: TSetPublish,
  user: JwtPayload,
) => {
  const exam = await prisma.exam.findUnique({
    where: { id },
    include: {
      sections: true,
      results: { include: { sections: true } },
    },
  });
  if (!exam) throw new AppError(httpStatus.NOT_FOUND, 'Exam not found');

  if (payload.isResultPublished) {
    // Pre-transaction guardrails. We check three things, in order of
    // strictness:
    //
    // (a) At least one examinee must be marked PRESENT. Without a single
    //     present student there's nothing meaningful to publish.
    // (b) At least one PRESENT student must have `marksEntered = true`.
    //     The flag is flipped by `upsertResultToDB` when the admin saves
    //     at least one non-default signal (a non-zero section mark,
    //     correctAnswers, notes, or remarks). This catches the
    //     "roster was materialised but no one ever touched the Results
    //     tab" case — `obtainedMarks` alone wouldn't catch it because
    //     pre-created section rows all start at 0.
    // (c) Every PRESENT student must have a section row for every exam
    //     section (the legacy completeness check). This catches the
    //     partial-fill case.
    const present = exam.results.filter((r) => !r.isAbsent);

    if (present.length === 0) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'Cannot publish: no examinees are marked PRESENT yet',
      );
    }

    if (!present.some((r) => r.marksEntered)) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'Cannot publish: no results have been entered yet. Open the Results tab and save at least one student.',
      );
    }

    const incomplete: string[] = [];
    for (const r of present) {
      const allFilled = exam.sections.every(
        (s) => r.sections.find((rs) => rs.sectionId === s.id) !== undefined,
      );
      if (!allFilled) {
        incomplete.push(r.studentId);
      }
    }
    if (incomplete.length > 0) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `${incomplete.length} student(s) still need marks entered. Resolve before publishing.`,
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    if (payload.isResultPublished) {
      await recomputeRanks(id, tx);
      await tx.exam.update({
        where: { id },
        data: {
          isResultPublished: true,
          publishedAt: new Date(),
          publishedById: user.userId,
        },
      });
    } else {
      await tx.exam.update({
        where: { id },
        data: {
          isResultPublished: false,
          publishedAt: null,
          publishedById: null,
        },
      });
      await tx.examResult.updateMany({
        where: { examId: id },
        data: { rank: null },
      });
    }

    await tx.activityLog.create({
      data: {
        actorId: user.userId,
        actorRole: user.role as 'SUPER_ADMIN' | 'ADMIN',
        action: payload.isResultPublished ? 'EXAM_PUBLISHED' : 'EXAM_UNPUBLISHED',
        entityType: 'Exam',
        entityId: id,
        description: payload.isResultPublished
          ? `Results for "${exam.title}" published`
          : `Results for "${exam.title}" unpublished`,
        metadata: { previousPublished: exam.isResultPublished },
      },
    });

    return tx.exam.findUnique({
      where: { id },
      include: { sections: { orderBy: { position: 'asc' } } },
    });
  });
};

// ────────────────────────────────────────────────────────────────────────────
// Roster management
// ────────────────────────────────────────────────────────────────────────────

const upsertRosterToDB = async (
  examId: string,
  payload: TUpsertRoster,
  user: JwtPayload,
) => {
  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    include: { sections: true },
  });
  if (!exam) throw new AppError(httpStatus.NOT_FOUND, 'Exam not found');
  if (exam.isResultPublished) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Cannot change the roster after results have been published',
    );
  }

  const add = payload.add ?? [];
  const remove = payload.remove ?? [];

  return prisma.$transaction(async (tx) => {
    if (remove.length > 0) {
      const removed = await tx.examResult.findMany({
        where: { examId, studentId: { in: remove } },
        select: { id: true },
      });
      await tx.examResult.deleteMany({
        where: { id: { in: removed.map((r) => r.id) } },
      });
    }
    if (add.length > 0) {
      // Filter out any that are already on the roster.
      const existing = await tx.examResult.findMany({
        where: { examId, studentId: { in: add } },
        select: { studentId: true },
      });
      const existingSet = new Set(existing.map((e) => e.studentId));
      const fresh = add.filter((sid) => !existingSet.has(sid));
      if (fresh.length > 0) {
        await tx.examResult.createMany({
          data: fresh.map((studentId) => ({
            examId,
            studentId,
            // Same rule as createExamToDB — newly-added roster members
            // start ABSENT and must be flipped PRESENT via attendance.
            isAbsent: true,
            obtainedMarks: 0,
          })),
        });
        const results = await tx.examResult.findMany({
          where: { examId, studentId: { in: fresh } },
          select: { id: true, studentId: true },
        });
        const rows: Prisma.ExamResultSectionCreateManyInput[] = [];
        for (const r of results) {
          for (const s of exam.sections) {
            rows.push({ resultId: r.id, sectionId: s.id, obtainedMarks: 0 });
          }
        }
        if (rows.length > 0) {
          await tx.examResultSection.createMany({ data: rows });
        }
      }
    }
    await tx.activityLog.create({
      data: {
        actorId: user.userId,
        actorRole: user.role as 'SUPER_ADMIN' | 'ADMIN',
        action: 'EXAM_ROSTER_UPDATED',
        entityType: 'Exam',
        entityId: examId,
        description: `Roster updated (${add.length} added, ${remove.length} removed)`,
        metadata: { added: add, removed: remove },
      },
    });
    return { added: add.length, removed: remove.length };
  });
};

// ────────────────────────────────────────────────────────────────────────────
// Attendance
// ────────────────────────────────────────────────────────────────────────────

const setAttendanceToDB = async (
  examId: string,
  payload: TSetAttendance,
  user: JwtPayload,
) => {
  const result = await prisma.examResult.findUnique({
    where: { examId_studentId: { examId, studentId: payload.studentId } },
  });
  if (!result) {
    throw new AppError(
      httpStatus.NOT_FOUND,
      'Student is not on this exam roster',
    );
  }

  return prisma.$transaction(async (tx) => {
    if (payload.isAbsent) {
      // Zero out marks so the result-entry UI cannot accidentally keep
      // showing stale numbers. The admin must re-enter on flip-back.
      await tx.examResultSection.updateMany({
        where: { resultId: result.id },
        data: { obtainedMarks: 0, correctAnswers: null },
      });
    }
    const updated = await tx.examResult.update({
      where: { id: result.id },
      data: {
        isAbsent: payload.isAbsent,
        obtainedMarks: payload.isAbsent ? 0 : result.obtainedMarks,
        // Flipping to ABSENT removes the student from the publish-eligible
        // set entirely, so we clear `marksEntered` too. Flipping back to
        // PRESENT leaves `marksEntered` as-is — the admin will need to
        // re-enter marks via `upsertResultToDB` to flip it back to true.
        ...(payload.isAbsent ? { marksEntered: false } : {}),
      },
    });
    await tx.activityLog.create({
      data: {
        actorId: user.userId,
        actorRole: user.role as 'SUPER_ADMIN' | 'ADMIN',
        action: 'EXAM_ATTENDANCE_UPDATED',
        entityType: 'ExamResult',
        entityId: result.id,
        description: payload.isAbsent
          ? `Student marked ABSENT`
          : `Student marked PRESENT`,
        metadata: { examId, studentId: payload.studentId, isAbsent: payload.isAbsent },
      },
    });
    return updated;
  });
};

const bulkAttendanceByStudentIdToDB = async (
  examId: string,
  payload: TBulkAttendanceByStudentId,
  user: JwtPayload,
) => {
  // The barcode scanner feeds raw studentId *strings* (e.g. "BD00042"). We
  // resolve each one to a Student and check whether they're on the roster.
  const trimmed = payload.studentIds.map((s) => s.trim()).filter(Boolean);
  const unique = Array.from(new Set(trimmed));

  const users = await prisma.user.findMany({
    where: { studentId: { in: unique }, isDeleted: false },
    select: { id: true, studentId: true },
  });
  const userIdByCode = new Map(users.map((u) => [u.studentId, u.id]));

  const students = await prisma.student.findMany({
    where: { userId: { in: users.map((u) => u.id) }, isDeleted: false },
    select: { id: true, userId: true },
  });
  const studentIdByUserId = new Map(students.map((s) => [s.userId, s.id]));

  const roster = await prisma.examResult.findMany({
    where: { examId },
    select: { id: true, studentId: true, isAbsent: true },
  });
  const rosterMap = new Map(roster.map((r) => [r.studentId, r]));

  const marked: string[] = [];
  const skipped: string[] = [];
  const unknown: string[] = [];

  for (const code of unique) {
    const userId = userIdByCode.get(code);
    const studentId = userId ? studentIdByUserId.get(userId) : undefined;
    if (!studentId) {
      unknown.push(code);
      continue;
    }
    const row = rosterMap.get(studentId);
    if (!row) {
      skipped.push(code);
      continue;
    }
    if (!row.isAbsent) {
      marked.push(code); // already present — no-op
      continue;
    }
    // Flip present.
    await prisma.examResult.update({
      where: { id: row.id },
      data: { isAbsent: false },
    });
    marked.push(code);
  }

  await prisma.activityLog.create({
    data: {
      actorId: user.userId,
      actorRole: user.role as 'SUPER_ADMIN' | 'ADMIN',
      action: 'EXAM_ATTENDANCE_BULK_SCANNED',
      entityType: 'Exam',
      entityId: examId,
      description: `Barcode scanner: ${marked.length} marked present, ${unknown.length} unknown, ${skipped.length} not on roster`,
      metadata: { marked, unknown, skipped },
    },
  });

  return { marked, unknown, skipped };
};

// ────────────────────────────────────────────────────────────────────────────
// Result entry (single + bulk)
// ────────────────────────────────────────────────────────────────────────────

const upsertResultToDB = async (
  examId: string,
  payload: TUpsertResult,
  user: JwtPayload,
) => {
  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    include: { sections: true },
  });
  if (!exam) throw new AppError(httpStatus.NOT_FOUND, 'Exam not found');

  const result = await prisma.examResult.findUnique({
    where: { examId_studentId: { examId, studentId: payload.studentId } },
  });
  if (!result) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Student is not on this exam roster — add them first via the Roster tab',
    );
  }
  if (result.isAbsent && !payload.isAbsent) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Cannot enter marks for an absent student — flip attendance to PRESENT first',
    );
  }

  // Verify all section ids belong to this exam.
  const sectionById = new Map(exam.sections.map((s) => [s.id, s]));
  for (const rs of payload.sections) {
    if (!sectionById.has(rs.sectionId)) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Section ${rs.sectionId} does not belong to this exam`,
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    let total = 0;

    for (const rs of payload.sections) {
      const section = sectionById.get(rs.sectionId)!;
      // Clamp marks.
      let obtained = Math.min(rs.obtainedMarks, section.totalMarks);
      // For MCQ: if correctAnswers is provided, derive marks server-side
      // unless caller explicitly passed obtainedMarks that differs.
      let correctAnswers: number | null = rs.correctAnswers ?? null;
      if (section.type === 'MCQ' && correctAnswers !== null) {
        correctAnswers = Math.min(correctAnswers, section.totalQuestions);
        obtained = Math.min(
          correctAnswers * Number(section.marksPerQuestion),
          section.totalMarks,
        );
      }
      total += obtained;

      await tx.examResultSection.upsert({
        where: { resultId_sectionId: { resultId: result.id, sectionId: section.id } },
        create: {
          resultId: result.id,
          sectionId: section.id,
          correctAnswers,
          obtainedMarks: obtained,
          notes: rs.notes ?? null,
        },
        update: {
          correctAnswers,
          obtainedMarks: obtained,
          notes: rs.notes ?? null,
        },
      });
    }

    await tx.examResult.update({
      where: { id: result.id },
      data: {
        obtainedMarks: total,
        remarks: payload.remarks ?? null,
        updatedById: user.userId,
      },
    });

    // Flip `marksEntered` if the saved row now counts as "marks entered".
    // We re-read the sections because the upsert loop above may have
    // derived `obtainedMarks` for MCQ rows from `correctAnswers`, so a row
    // the caller submitted as `correctAnswers: 18` should now reflect
    // 18 * marksPerQuestion in the helper's view. If the admin pressed
    // Save on a row where every section is `0` and no other sentinel is
    // set, the helper returns false and we leave the flag alone — publish
    // stays blocked until they add at least one non-default signal.
    const refreshed = await tx.examResult.findUnique({
      where: { id: result.id },
      include: { sections: true },
    });
    if (
      refreshed &&
      resultHasMarksEntered(
        refreshed.sections.map((s) => ({
          obtainedMarks: s.obtainedMarks,
          correctAnswers: s.correctAnswers,
          notes: s.notes,
        })),
        refreshed.remarks,
      )
    ) {
      await tx.examResult.update({
        where: { id: result.id },
        data: { marksEntered: true },
      });
    }

    if (exam.isResultPublished) {
      await recomputeRanks(examId, tx);
    }

    await tx.activityLog.create({
      data: {
        actorId: user.userId,
        actorRole: user.role as 'SUPER_ADMIN' | 'ADMIN',
        action: 'EXAM_RESULT_UPDATED',
        entityType: 'ExamResult',
        entityId: result.id,
        description: `Marks updated (total: ${total})`,
        metadata: { examId, studentId: payload.studentId, total },
      },
    });

    return tx.examResult.findUnique({
      where: { id: result.id },
      include: { sections: { include: { section: true } } },
    });
  });
};

const bulkResultsToDB = async (
  examId: string,
  payload: TBulkResults,
  user: JwtPayload,
) => {
  const succeeded: { studentId: string; total: number }[] = [];
  const failed: { studentId: string; error: string }[] = [];
  for (const r of payload.results) {
    try {
      const out = await upsertResultToDB(examId, r, user);
      succeeded.push({
        studentId: r.studentId,
        total: out?.obtainedMarks ?? 0,
      });
    } catch (e) {
      const msg =
        e instanceof AppError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Unknown error';
      failed.push({ studentId: r.studentId, error: msg });
    }
  }
  return { succeeded, failed };
};

// ────────────────────────────────────────────────────────────────────────────
// Read paths
// ────────────────────────────────────────────────────────────────────────────

const getExamByIdToDB = async (id: string) => {
  const exam = await prisma.exam.findUnique({
    where: { id },
    include: {
      course: { select: { id: true, name: true, hscBatch: true } },
      sections: { orderBy: { position: 'asc' } },
      results: {
        include: {
          student: {
            // Surface extra student fields the admin needs to identify
            // examinees at a glance on the Roster / Results tabs (mobile,
            // college, batch assignment). Only non-deleted batches are
            // included so we never show ghost rows.
            include: {
              user: {
                select: { studentId: true, name: true, nickname: true },
              },
              batches: {
                where: { isDeleted: false },
                select: {
                  id: true,
                  batchDay: true,
                  batchTime: true,
                  hscBatch: true,
                },
              },
            },
          },
          sections: {
            include: { section: true },
          },
        },
      },
    },
  });
  if (!exam) throw new AppError(httpStatus.NOT_FOUND, 'Exam not found');

  // Sort roster: present students first (by descending marks), then absent.
  const present = exam.results
    .filter((r) => !r.isAbsent)
    .sort((a, b) => b.obtainedMarks - a.obtainedMarks);
  const absent = exam.results.filter((r) => r.isAbsent);
  const sorted = [...present, ...absent];

  const topTen = present
    .slice()
    .sort((a, b) => {
      if (b.obtainedMarks !== a.obtainedMarks)
        return b.obtainedMarks - a.obtainedMarks;
      return a.updatedAt.getTime() - b.updatedAt.getTime(); // tie → earliest first
    })
    .slice(0, 10)
    .map((r) => ({
      resultId: r.id,
      studentId: r.studentId,
      studentName: r.student.user.name,
      studentCode: r.student.user.studentId,
      obtainedMarks: r.obtainedMarks,
      rank: r.rank ?? null,
    }));

  const presentMarks = present.map((r) => r.obtainedMarks);
  const highestMarks = presentMarks.length > 0 ? Math.max(...presentMarks) : 0;
  const averageMarks =
    presentMarks.length > 0
      ? Math.round(presentMarks.reduce((a, b) => a + b, 0) / presentMarks.length)
      : 0;

  return {
    id: exam.id,
    title: exam.title,
    syllabus: exam.syllabus,
    examDate: exam.examDate,
    courseId: exam.courseId,
    course: exam.course,
    totalMarks: exam.totalMarks,
    isResultPublished: exam.isResultPublished,
    publishedAt: exam.publishedAt,
    sections: exam.sections.map((s) => ({
      id: s.id,
      type: s.type,
      name: s.name,
      totalQuestions: s.totalQuestions,
      marksPerQuestion: Number(s.marksPerQuestion),
      totalMarks: s.totalMarks,
      position: s.position,
    })),
    createdAt: exam.createdAt,
    updatedAt: exam.updatedAt,
    roster: sorted.map((r) => ({
      id: r.id,
      studentId: r.studentId,
      studentName: r.student.user.name,
      studentCode: r.student.user.studentId,
      studentMobile: r.student.mobile,
      studentCollege: r.student.college ?? null,
      // `batches` is filtered to non-deleted in the Prisma include. We pass
      // them through unchanged so the UI can format Day/Time/HSC batch
      // labels locally without us hard-coding a presentation rule here.
      studentBatches: r.student.batches,
      isAbsent: r.isAbsent,
      obtainedMarks: r.obtainedMarks,
      // Whether the admin has explicitly saved marks for this student.
      // Drives the "Publish results" gating — see `setExamPublishToDB`.
      marksEntered: r.marksEntered,
      rank: r.rank ?? null,
      remarks: r.remarks ?? null,
      sections: r.sections.map((rs) => ({
        sectionId: rs.sectionId,
        name: rs.section.name,
        type: rs.section.type,
        totalQuestions: rs.section.totalQuestions,
        marksPerQuestion: Number(rs.section.marksPerQuestion),
        totalMarks: rs.section.totalMarks,
        correctAnswers: rs.correctAnswers ?? null,
        obtainedMarks: rs.obtainedMarks,
      })),
    })),
    topTen,
    stats: {
      presentCount: present.length,
      absentCount: absent.length,
      highestMarks,
      averageMarks,
    },
  };
};

const getAllExamsFromDB = async (
  filters: TListExams,
  options: { page?: number; limit?: number; sortBy?: string; sortOrder?: 'asc' | 'desc' },
) => {
  const { page, limit, skip, sortBy, sortOrder } = calculatePagination(options);
  const { searchTerm, courseId, isResultPublished } = filters;

  const andConditions: Prisma.ExamWhereInput[] = [];
  if (searchTerm) {
    andConditions.push({
      OR: [
        { title: { contains: searchTerm, mode: 'insensitive' } },
        { syllabus: { contains: searchTerm, mode: 'insensitive' } },
      ],
    });
  }
  if (courseId) andConditions.push({ courseId });
  // `isResultPublished` arrives as a raw string from `req.query` (the
  // validateRequest middleware discards the parsed Zod result). Treat
  // undefined as "no filter" and coerce the rest to a real boolean so
  // Prisma's `where: { isResultPublished: <bool> }` actually filters.
  if (isResultPublished !== undefined) {
    andConditions.push({ isResultPublished: isTruthyQuery(isResultPublished) });
  }

  const where: Prisma.ExamWhereInput =
    andConditions.length > 0 ? { AND: andConditions } : {};

  const [data, total] = await Promise.all([
    prisma.exam.findMany({
      where,
      skip,
      take: limit,
      orderBy: { [sortBy || 'createdAt']: sortOrder || 'desc' },
      include: {
        course: { select: { id: true, name: true } },
        _count: { select: { results: true, sections: true } },
      },
    }),
    prisma.exam.count({ where }),
  ]);

  return {
    data,
    meta: { page, limit, total },
  };
};

const getMyResultsFromDB = async (studentUserId: string, query: TGetMyResults) => {
  const { page, limit, skip } = calculatePagination({
    page: query.page,
    limit: query.limit ?? 20,
  });

  const student = await prisma.student.findFirst({
    where: { userId: studentUserId, isDeleted: false },
    select: {
      id: true,
      studentCourses: {
        where: { isDeleted: false },
        select: { courseId: true },
      },
      examResults: {
        // We need to know which exams the student is on the roster of.
        // The where clause here is intentionally broad — any row counts
        // (ABSENT placeholders from `upsertRoster` are still "I am on
        // the roster" signals).
        select: {
          examId: true,
          exam: { select: { courseId: true } },
        },
      },
    },
  });
  if (!student) {
    return {
      data: [],
      meta: { page, limit, total: 0 },
    };
  }

  // Build the set of courses the student is "in scope" for, mirroring
  // `getMyUpcomingExamsFromDB`:
  //   - every active `StudentCourse.courseId`, OR
  //   - every course the student has any `ExamResult` row on.
  const courseIdSet = new Set<string>();
  for (const sc of student.studentCourses) courseIdSet.add(sc.courseId);
  for (const er of student.examResults) courseIdSet.add(er.exam.courseId);
  const eligibleCourseIds = Array.from(courseIdSet);

  // Exams on which the student has a real roster row (i.e. a per-row
  // `ExamResult` already exists). We use the result row's lifecycle to
  // look up real marks later.
  const rosterExamIdSet = new Set(student.examResults.map((er) => er.examId));

  if (eligibleCourseIds.length === 0) {
    return { data: [], meta: { page, limit, total: 0 } };
  }

  const courseFilter = query.courseId ? { courseId: query.courseId } : {};
  const publishedExamWhere = {
    isResultPublished: true,
    courseId: { in: eligibleCourseIds },
    ...courseFilter,
  };

  /*
   * Path A — Published exams where the student HAS a roster row.
   * Drives real marks / highest / rank.
   */
  const rosterWhere: Prisma.ExamResultWhereInput = {
    studentId: student.id,
    exam: publishedExamWhere,
  };

  const [rosterData, rosterTotal] = await Promise.all([
    prisma.examResult.findMany({
      where: rosterWhere,
      skip,
      take: limit,
      orderBy: { exam: { examDate: 'desc' } },
      include: {
        exam: {
          include: { course: { select: { id: true, name: true } } },
        },
        sections: { include: { section: true } },
      },
    }),
    prisma.examResult.count({ where: rosterWhere }),
  ]);

  // For each roster result, compute the highest marks in that exam.
  const rosterExamIds = rosterData.map((d) => d.examId);
  const highestByExam = new Map<string, number>();
  if (rosterExamIds.length > 0) {
    const groups = await prisma.examResult.groupBy({
      by: ['examId'],
      where: {
        examId: { in: rosterExamIds },
        isAbsent: false,
      },
      _max: { obtainedMarks: true },
    });
    for (const g of groups) {
      highestByExam.set(g.examId, g._max.obtainedMarks ?? 0);
    }
  }

  const rosterResults = rosterData.map((r) => ({
    resultId: r.id,
    examId: r.examId,
    examTitle: r.exam.title,
    examDate: r.exam.examDate,
    courseId: r.exam.courseId,
    courseName: r.exam.course.name,
    totalMarks: r.exam.totalMarks,
    // Same flag as before — every row here comes from a published exam
    // (filtered server-side), and the frontend uses it for UI gating.
    isResultPublished: true as const,
    // True when this entry corresponds to a real `ExamResult` row. The
    // complementary synthetic entries (Path B below) carry `false`.
    hasResultRow: true as const,
    obtainedMarks: r.obtainedMarks,
    highestMarks: highestByExam.get(r.examId) ?? 0,
    rank: r.rank ?? null,
    sections: r.sections.map((s) => ({
      sectionId: s.sectionId,
      name: s.section.name,
      type: s.section.type,
      obtainedMarks: s.obtainedMarks,
      totalMarks: s.section.totalMarks,
    })),
  }));

  /*
   * Path B — Published exams for an eligible course where the student
   * has NO `ExamResult` row. The student is enrolled in the course so
   * the exam is "their" exam in spirit; the admin simply hasn't added
   * them to this exam's roster. Surface a synthetic entry so the
   * student at least sees the exam on the Previous tab. Marks are
   * zeroed and `hasResultRow: false` tells the frontend to render an
   * "Awaiting your marks" notice instead of real numbers.
   */
  const rosterPublishedExamIds = new Set(rosterData.map((r) => r.examId));
  const syntheticWhere: Prisma.ExamWhereInput = {
    ...publishedExamWhere,
    id: rosterExamIdSet.size > 0
      ? { notIn: Array.from(rosterExamIdSet) }
      : undefined,
  };

  const [syntheticExams, syntheticTotal] = await Promise.all([
    prisma.exam.findMany({
      where: syntheticWhere,
      skip: 0, // we apply pagination manually below after merging
      take: limit,
      orderBy: { examDate: 'desc' },
      include: {
        course: { select: { id: true, name: true } },
        sections: { orderBy: { position: 'asc' } },
      },
    }),
    prisma.exam.count({ where: syntheticWhere }),
  ]);

  // Synthesise TMyResult-shaped entries for exams the student is
  // enrolled in but not on the roster of.
  const syntheticResults = syntheticExams
    .filter((e) => !rosterPublishedExamIds.has(e.id))
    .map((e) => ({
      resultId: e.id, // Echo exam id so the key is unique even without a real result row.
      examId: e.id,
      examTitle: e.title,
      examDate: e.examDate,
      courseId: e.courseId,
      courseName: e.course.name,
      totalMarks: e.totalMarks,
      isResultPublished: true as const,
      hasResultRow: false as const,
      obtainedMarks: 0,
      highestMarks: 0,
      rank: null as number | null,
      sections: e.sections.map((s) => ({
        sectionId: s.id,
        name: s.name,
        type: s.type,
        obtainedMarks: 0,
        totalMarks: s.totalMarks,
      })),
    }));

  // Merge by exam id (synthetic first, then roster) deduping — the
  // same exam shouldn't appear twice. `hasResultRow` wins so the
  // student sees their real numbers whenever possible.
  const merged = new Map<string, (typeof rosterResults)[number] | (typeof syntheticResults)[number]>();
  for (const r of syntheticResults) merged.set(r.examId, r);
  for (const r of rosterResults) merged.set(r.examId, r);

  const all = Array.from(merged.values()).sort(
    (a, b) => new Date(b.examDate).getTime() - new Date(a.examDate).getTime(),
  );

  // Apply page/limit on the merged list. `meta.total` reflects the
  // full set so the client can paginate correctly.
  const paged = all.slice(skip, skip + limit);
  const total = rosterTotal + syntheticTotal;

  return {
    data: paged,
    meta: { page, limit, total },
  };
};

/**
 * Upcoming exams for the signed-in student.
 *
 * A student is considered "interested" in an exam if EITHER:
 *   1. They have a non-deleted `StudentCourse` row for that course, OR
 *   2. They are on the exam's roster (an `ExamResult` row already exists
 *      for them on that exam).
 *
 * Source (2) matters because the exam roster is the source of truth for
 * who is sitting the exam. A student can be on the roster without an
 * active enrollment — e.g. their `StudentCourse` was soft-deleted after
 * they were registered, or the admin added them via `upsertRoster` as a
 * one-off examinee. Using only `StudentCourse` would miss those students
 * and leave the Upcoming tab empty in the very case the user reported:
 * "there is a student of this course as examinee, but the upcoming tab
 * doesn't show the exam".
 *
 * Returns every exam whose `examDate` is today or in the future
 * (regardless of publish state) so the student panel can surface the
 * full schedule. Sorted ascending by `examDate` so the soonest exam
 * is on top.
 *
 * Optional `courseId` filter narrows to a single course. `limit` is
 * capped at 100 to keep the dashboard payload small.
 */
const getMyUpcomingExamsFromDB = async (
  studentUserId: string,
  query: TGetMyUpcomingExams,
) => {
  const { page, limit, skip } = calculatePagination({
    page: query.page,
    limit: query.limit ?? 20,
  });

  const student = await prisma.student.findFirst({
    where: { userId: studentUserId, isDeleted: false },
    select: {
      id: true,
      studentCourses: {
        where: { isDeleted: false },
        select: { courseId: true },
      },
      // Exam results — i.e. the student's roster memberships. The
      // existence of an `ExamResult` row for this student on a given
      // exam is the canonical "this student is registered for this
      // exam" signal, regardless of `isAbsent` (the admin flips that
      // during attendance tracking — it doesn't affect eligibility).
      examResults: {
        select: {
          exam: {
            select: {
              courseId: true,
            },
          },
        },
      },
    },
  });
  if (!student) {
    return { data: [], meta: { page, limit, total: 0 } };
  }

  /*
   * Build the set of courseIds the student should see upcoming exams
   * for, deduped via a Set.
   *
   * `examDate` is stored as `@db.Date`, so the JS Date round-trip puts
   * the time component at 00:00 UTC. Comparing with a server-local
   * `setHours(0,0,0,0)` works for non-TZ-sensitive servers but is fragile
   * in the rare case where the server's TZ puts "today" on the previous
   * calendar day in UTC. To stay correct across TZ configurations, we
   * compare in the same calendar-day frame as the database: derive
   * today's date in the SERVER's local timezone as a YYYY-MM-DD string,
   * then compare against the JS Date that Prisma materialised from
   * that exact same column. Both sides share the same TZ semantics, so
   * an exam whose stored date is `today` will always satisfy
   * `examDate >= todayDate`.
   */
  const courseIdSet = new Set<string>();
  for (const sc of student.studentCourses) courseIdSet.add(sc.courseId);
  for (const er of student.examResults) courseIdSet.add(er.exam.courseId);

  if (courseIdSet.size === 0) {
    return { data: [], meta: { page, limit, total: 0 } };
  }
  const eligibleCourseIds = Array.from(courseIdSet);

  const now = new Date();
  // YYYY-MM-DD derived from local-time components so it lines up with
  // whatever wall-clock date the admin used when creating the exam.
  const todayStr =
    `${now.getFullYear()}-` +
    `${String(now.getMonth() + 1).padStart(2, '0')}-` +
    `${String(now.getDate()).padStart(2, '0')}`;
  // `T00:00:00` (no Z) is interpreted in the SERVER's local timezone by
  // the Postgres driver, which is exactly what we want — it matches
  // the wall-clock date we just computed.
  const todayDate = new Date(`${todayStr}T00:00:00`);

  const where: Prisma.ExamWhereInput = {
    courseId: { in: eligibleCourseIds },
    examDate: { gte: todayDate },
    ...(query.courseId ? { courseId: query.courseId } : {}),
  };

  const [data, total] = await Promise.all([
    prisma.exam.findMany({
      where,
      skip,
      take: limit,
      orderBy: { examDate: 'asc' },
      include: {
        course: { select: { id: true, name: true } },
        // Lightweight section summary so the student details dialog can
        // render the per-section breakdown (name / type / questions /
        // per-question marks / total) without a second round-trip. We
        // intentionally do NOT include any result marks or roster data
        // here — students should never see other students' marks or
        // personal details through this endpoint.
        sections: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            type: true,
            name: true,
            totalQuestions: true,
            marksPerQuestion: true,
            totalMarks: true,
            position: true,
          },
        },
        _count: { select: { sections: true } },
      },
    }),
    prisma.exam.count({ where }),
  ]);

  return {
    data: data.map((e) => ({
      id: e.id,
      title: e.title,
      syllabus: e.syllabus,
      examDate: e.examDate,
      isResultPublished: e.isResultPublished,
      courseId: e.courseId,
      courseName: e.course.name,
      totalMarks: e.totalMarks,
      sectionCount: e._count.sections,
      sections: e.sections.map((s) => ({
        id: s.id,
        type: s.type,
        name: s.name,
        totalQuestions: s.totalQuestions,
        marksPerQuestion: Number(s.marksPerQuestion),
        totalMarks: s.totalMarks,
        position: s.position,
      })),
    })),
    meta: { page, limit, total },
  };
};

// ────────────────────────────────────────────────────────────────────────────
// Public surface
// ────────────────────────────────────────────────────────────────────────────

export const ExamService = {
  createExamToDB,
  updateExamToDB,
  setExamPublishToDB,
  upsertRosterToDB,
  setAttendanceToDB,
  bulkAttendanceByStudentIdToDB,
  upsertResultToDB,
  bulkResultsToDB,
  getExamByIdToDB,
  getAllExamsFromDB,
  getMyResultsFromDB,
  getMyUpcomingExamsFromDB,
};
