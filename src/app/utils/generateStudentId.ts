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

const generateStudentId = async (
  hscBatch: HscBatch,
  courseName: CourseName,
): Promise<string> => {
  const batchNum = HSC_BATCH_TO_NUMBER[hscBatch];
  const yearDigit = COURSE_NAME_TO_YEAR_DIGIT[courseName];
  const prefix = `${batchNum}${yearDigit}`;

  const latest = await prisma.user.findFirst({
    where: { studentId: { startsWith: prefix } },
    orderBy: { studentId: 'desc' },
    select: { studentId: true },
  });

  let nextRoll = STARTING_ROLL;
  if (latest) {
    const match = latest.studentId.match(/(\d{3})$/);
    if (match) {
      nextRoll = Number(match[1]) + 1;
    }
  }

  const padded = String(nextRoll).padStart(3, '0');
  return `${prefix}${padded}`;
};

export default generateStudentId;