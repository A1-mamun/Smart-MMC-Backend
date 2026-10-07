import prisma from './prisma';
import { CourseName, HscBatch } from '@prisma/client';

const HSC_BATCH_TO_NUMBER: Record<HscBatch, string> = {
  BATCH_25: '25',
  BATCH_26: '26',
  BATCH_27: '27',
  BATCH_28: '28',
};

const COURSE_NAME_TO_YEAR_DIGIT: Record<CourseName, string> = {
  HSC_1ST_YEAR: '1',
  HSC_2ND_YEAR: '2',
  HSC_FINAL_PREPARATION: '3',
  ADMISSION: '4',
};

const STARTING_ROLL = 200;

/**
 * Generate the next per-enrollment StudentCourse.studentCourseId for a
 * `(hscBatch, courseName)` pair. The format is `{batchNum}{yearDigit}{roll}`
 * (e.g. `27206` = HSC batch 27, year 2, roll 206), and the roll
 * counter starts at 200.
 *
 * Source-of-truth for the next roll: `StudentCourse.studentCourseId`
 * directly. Searching `User.studentId` would be wrong because a student
 * admitted to HSC_1ST_YEAR (roll 206) then HSC_2ND_YEAR has TWO
 * distinct per-enrollment IDs — the second admit would either pick a
 * roll that collides with a different user (if any user with the
 * new prefix existed) or, when no user with that prefix existed,
 * fall back to 200 and overwrite the wrong row when stamped on
 * User.studentId. The correct scope is the per-enrollment column —
 * same prefix can appear across many users, the only thing that
 * matters is "no two active enrollments share the same ID".
 *
 * Concurrency: a simple findFirst + write has a known race where two
 * parallel admits can both read the same `latest` and stamp the same
 * next roll. The unique index on `studentCourseId` is the last line
 * of defence — the second admit fails with a unique-constraint
 * violation and the caller retries. The seat-cap gate (the
 * transaction in student.service.ts) is what guarantees the admit
 * succeeds atomically with the right ID; this function just returns
 * the next candidate.
 */
const generateStudentId = async (
  hscBatch: HscBatch,
  courseName: CourseName,
): Promise<string> => {
  const batchNum = HSC_BATCH_TO_NUMBER[hscBatch];
  const yearDigit = COURSE_NAME_TO_YEAR_DIGIT[courseName];
  const prefix = `${batchNum}${yearDigit}`;

  const latest = await prisma.studentCourse.findFirst({
    where: {
      studentCourseId: { startsWith: prefix },
      isDeleted: false,
    },
    orderBy: { studentCourseId: 'desc' },
    select: { studentCourseId: true },
  });

  let nextRoll = STARTING_ROLL;
  if (latest?.studentCourseId) {
    const match = latest.studentCourseId.match(/(\d{3})$/);
    if (match) {
      nextRoll = Number(match[1]) + 1;
    }
  }

  const padded = String(nextRoll).padStart(3, '0');
  return `${prefix}${padded}`;
};

export default generateStudentId;