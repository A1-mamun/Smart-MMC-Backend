import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

type DayName = string;

async function main() {
  const config = {
    superAdminName: process.env.SUPER_ADMIN_NAME || 'Super Admin',
    superAdminStudentId: process.env.SUPER_ADMIN_STUDENT_ID || 'SMC-ADMIN-001',
    superAdminPassword: process.env.SUPER_ADMIN_PASSWORD || 'ChangeMe123!',
    bcryptRounds: Number(process.env.BCRYPT_SALT_ROUNDS) || 12,
  };

  const superAdminExists = await prisma.user.findUnique({
    where: { studentId: config.superAdminStudentId },
  });

  if (!superAdminExists) {
    console.log('Creating Super Admin...');
    const hashed = await bcrypt.hash(config.superAdminPassword, config.bcryptRounds);
    await prisma.user.create({
      data: {
        studentId: config.superAdminStudentId,
        name: config.superAdminName,
        password: hashed,
        role: 'SUPER_ADMIN',
        mustChangePassword: false,
        passwordLevel: 1,
        passwordChangedAt: new Date(),
      },
    });
    console.log(
      `Super Admin created: ${config.superAdminStudentId} / ${config.superAdminPassword}`,
    );
  } else {
    console.log('Super Admin already exists, skipping.');
  }

  const courses: Array<{
    name: 'HSC_1ST_YEAR' | 'HSC_2ND_YEAR' | 'HSC_FINAL_PREPARATION' | 'ADMISSION';
    fee: number;
    description: string;
    hscBatch: 'BATCH_25' | 'BATCH_26' | 'BATCH_27' | 'BATCH_28';
    batchDays: Array<{ name: string; days: DayName[]; times: string[] }>;
  }> = [
    {
      name: 'HSC_1ST_YEAR',
      fee: 12000,
      description: 'HSC 1st Year comprehensive course',
      hscBatch: 'BATCH_27',
      batchDays: [
        { name: 'SAT', days: ['Saturday', 'Monday', 'Wednesday'], times: ['3:00 PM', '4:30 PM'] },
        { name: 'SUN', days: ['Sunday', 'Tuesday', 'Thursday'], times: ['7:00 AM', '8:30 AM'] },
      ],
    },
    {
      name: 'HSC_2ND_YEAR',
      fee: 15000,
      description: 'HSC 2nd Year comprehensive course',
      hscBatch: 'BATCH_27',
      batchDays: [
        {
          name: 'SAT',
          days: ['Saturday', 'Monday', 'Wednesday'],
          times: ['7:00 AM', '8:30 AM'],
        },
        { name: 'SUN', days: ['Sunday', 'Tuesday', 'Thursday'], times: ['3:00 PM', '4:30 PM'] },
      ],
    },
    {
      name: 'HSC_FINAL_PREPARATION',
      fee: 8000,
      description: 'Final preparation / model test batch',
      hscBatch: 'BATCH_27',
      batchDays: [
        {
          name: 'SAT-FRI',
          days: ['Saturday', 'Monday', 'Wednesday', 'Friday'],
          times: ['5:00 PM'],
        },
        {
          name: 'SUN-FRI',
          days: ['Sunday', 'Tuesday', 'Thursday', 'Friday'],
          times: ['6:00 PM'],
        },
      ],
    },
    {
      name: 'ADMISSION',
      fee: 10000,
      description: 'University admission preparation',
      hscBatch: 'BATCH_27',
      batchDays: [
        { name: 'SUN', days: ['Sunday', 'Tuesday', 'Thursday'], times: ['4:00 PM'] },
        {
          name: 'SAT',
          days: ['Saturday', 'Monday', 'Wednesday'],
          times: ['10:00 AM', '7:00 PM'],
        },
      ],
    },
  ];

  for (const course of courses) {
    await prisma.$transaction(async (tx) => {
      const existingCourse = await tx.course.findFirst({
        where: { name: course.name },
      });

      let courseRecord;

      if (existingCourse) {
        courseRecord = await tx.course.update({
          where: { id: existingCourse.id },
          data: {
            fee: course.fee,
            description: course.description,
            isActive: true,
            hscBatch: course.hscBatch,
          },
        });
        console.log(`Updated course: ${course.name}`);
      } else {
        courseRecord = await tx.course.create({
          data: {
            name: course.name,
            fee: course.fee,
            description: course.description,
            hscBatch: course.hscBatch,
            isActive: true,
          },
        });
        console.log(`Created course: ${course.name}`);
      }

      // Delete old batch days
      await tx.batchDay.deleteMany({
        where: { courseId: courseRecord.id },
      });

      // Create new batch days
      await tx.batchDay.createMany({
        data: course.batchDays.map((day, position) => ({
          courseId: courseRecord.id,
          name: day.name,
          days: day.days,
          times: day.times,
          position,
        })),
      });
    });

    console.log(
      `Successfully seeded course: ${course.name} (${course.batchDays.length} batch days)`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
