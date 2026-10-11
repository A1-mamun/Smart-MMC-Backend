import httpStatus from 'http-status';
import AppError from '../errors/AppError';
import prisma from '../utils/prisma';

/**
 * IDOR guard: when a `STUDENT`-role user calls a route with a
 * `studentId` URL param, that param MUST refer to the student
 * record owned by their JWT's `userId`. Admins/super-admins
 * bypass this check (they can read any student's records).
 *
 * Without this, any logged-in student can pass an arbitrary
 * `studentId` and read someone else's payment / enrollment /
 * attendance history. See the security audit for details.
 */
export const assertStudentOwnership = async (
  role: string,
  jwtUserId: string,
  requestedStudentId: string,
): Promise<void> => {
  if (role === 'SUPER_ADMIN' || role === 'ADMIN') return;

  const student = await prisma.student.findUnique({
    where: { id: requestedStudentId },
    select: { userId: true },
  });

  if (!student || student.userId !== jwtUserId) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      'You are not authorized to access this student record',
    );
  }
};
