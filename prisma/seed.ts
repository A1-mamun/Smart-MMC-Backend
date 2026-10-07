import { PrismaClient, Prisma } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

type DayName = string;
type CourseName = 'HSC_1ST_YEAR' | 'HSC_2ND_YEAR' | 'HSC_FINAL_PREPARATION' | 'ADMISSION';
type HscBatch = 'BATCH_25' | 'BATCH_26' | 'BATCH_27' | 'BATCH_28';
type CourseStatus = 'ADMISSION' | 'ONGOING' | 'COMPLETE';

/**
 * Pad / trim a per-slot boolean array to match `times.length`. Mirrors
 * `normaliseBooleanArray` from `course.service.ts` so the seed never
 * leaves `slotStates` / `manualWindowOverride` out of sync with
 * `times[]` (the schema stores them as parallel arrays — see
 * `BatchDay.slotStates` and `BatchDay.manualWindowOverride`).
 *
 *   - Empty / undefined `incoming` → every entry is `defaultValue`
 *     (slotStates → false = "scanner off"; manualWindowOverride →
 *     false = "default 5-min check-in window").
 *   - Truncated if the seed SHRANK `times[]` (extra flags dropped).
 *   - Padded with `defaultValue` if the seed EXTENDED `times[]`
 *     (new slots default to `defaultValue`).
 */
const normaliseBooleanArray = (
  incoming: boolean[] | undefined,
  timesLength: number,
  defaultValue: boolean,
): boolean[] => {
  const result: boolean[] = [];
  for (let i = 0; i < timesLength; i++) {
    if (incoming && i < incoming.length) {
      result.push(Boolean(incoming[i]));
    } else {
      result.push(defaultValue);
    }
  }
  return result;
};

const normaliseSlotStates = (incoming: boolean[] | undefined, timesLength: number): boolean[] =>
  normaliseBooleanArray(incoming, timesLength, false);

async function main() {
  const config = {
    superAdminName: process.env?.SUPER_ADMIN_NAME,
    superAdminPhone: process.env.SUPER_ADMIN_PHONE,
    superAdminPassword: process.env.SUPER_ADMIN_PASSWORD,
    bcryptRounds: Number(process.env.BCRYPT_SALT_ROUNDS),
  };

  if (!config.superAdminPhone) {
    throw new Error('SUPER_ADMIN_PHONE is required (mobile is the login handle)');
  }
  if (!config.superAdminName) {
    throw new Error('SUPER_ADMIN_NAME is required');
  }
  if (!config.superAdminPassword) {
    throw new Error('SUPER_ADMIN_PASSWORD is required');
  }

  const superAdminExists = await prisma.user.findUnique({
    where: { mobile: config.superAdminPhone },
  });

  if (!superAdminExists) {
    console.log('Creating Super Admin...');
    const hashed = await bcrypt.hash(config.superAdminPassword, config.bcryptRounds);
    await prisma.user.create({
      data: {
        mobile: config.superAdminPhone,
        name: config.superAdminName,
        password: hashed,
        role: 'SUPER_ADMIN',
        mustChangePassword: false,
        passwordLevel: 1,
        passwordChangedAt: new Date(),
      },
    });
    console.log(`Super Admin created: ${config.superAdminPhone} / ${config.superAdminPassword}`);
  } else {
    console.log('Super Admin already exists, skipping.');
  }

  /**
   * Course catalogue seeded with the full data shape the schema
   * exposes. Field-level reasoning:
   *
   *   - `status` (ADMISSION / ONGOING / COMPLETE) drives the badge
   *     colour + picker visibility on the Courses page.
   *   - `isAllowAdmitAnotherCourse` is the enrollment gate. We let
   *     it follow `status` (COMPLETE → on, otherwise → off) which
   *     mirrors what `setStatusToDB` does in production so the
   *     flag and the status can't drift under the standard flow.
   *   - `totalSeats` is the per-slot cap (NULL = uncapped). The
   *     DB DEFAULT is 120, but we make it explicit on the seed so
   *     the value is visible at a glance and survives a future
   *     schema-default change.
   *   - `description` is the marketing copy shown on the Courses
   *     page search input.
   *
   * Each BatchDay row carries every parallel array the schema
   * requires so the seeded data exercises both create and read
   * paths without falling back on Prisma defaults:
   *
   *   - `durationMinutes` (nullable). Null → kiosk falls back to
   *     the legacy 60-min default. Set explicitly per row to
   *     exercise non-default countdown / progress paths.
   *   - `slotStates` — per-slot "scanner on" flag. Defaults to all
   *     OFF; the admin turns a slot ON from the Courses page when
   *     class is in session.
   *   - `manualWindowOverride` — per-slot "extend the 5-min check-
   *     in window". Defaults to all OFF (standard 5-min window).
   */
  const courses: Array<{
    name: CourseName;
    fee: number;
    description: string;
    hscBatch: HscBatch;
    status: CourseStatus;
    totalSeats: number | null;
    batchDays: Array<{
      name: string;
      days: DayName[];
      times: string[];
      durationMinutes?: number;
      // Defaults to all-false when omitted — mirrors
      // `normaliseSlotStates`. Set explicitly per row when the seed
      // wants to demo a non-default scanner layout.
      slotStates?: boolean[];
      manualWindowOverride?: boolean[];
    }>;
  }> = [
    {
      name: 'HSC_1ST_YEAR',
      fee: 12000,
      description: 'HSC 1st Year comprehensive course',
      hscBatch: 'BATCH_27',
      status: 'ONGOING',
      totalSeats: 120,
      batchDays: [
        {
          name: 'SAT-MON-WED',
          days: ['Saturday', 'Monday', 'Wednesday'],
          times: ['3:00 PM', '4:30 PM'],
          // 1h 15m session — exercises the live countdown / progress
          // bar with a non-default duration.
          durationMinutes: 75,
          // Demo the parallel-array plumbing: first slot admitting,
          // second slot locked. The admin will turn slots ON/OFF
          // from the Courses page in real life, but the seed ships a
          // concrete state so the kiosk renders meaningfully on a
          // fresh DB.
          slotStates: [true, false],
          manualWindowOverride: [false, false],
        },
        {
          name: 'SUN-TUE-THU',
          days: ['Sunday', 'Tuesday', 'Thursday'],
          times: ['2:20 PM', '3:30 PM'],
          durationMinutes: 60,
          // No durationMinutes → falls back to the legacy 60-min
          // default so the kiosk still has a sensible countdown.
          // No explicit slotStates → all slots start OFF; admin
          // flips the active one ON at class time.
        },
      ],
    },
    {
      name: 'HSC_2ND_YEAR',
      fee: 15000,
      description: 'HSC 2nd Year comprehensive course',
      hscBatch: 'BATCH_27',
      status: 'ONGOING',
      totalSeats: 120,
      batchDays: [
        {
          name: 'SAT-MON-WED',
          days: ['Saturday', 'Monday', 'Wednesday'],
          times: ['7:00 AM', '8:30 AM'],
          durationMinutes: 90,
          slotStates: [false, false],
          manualWindowOverride: [false, false],
        },
        {
          name: 'SUN-TUE-THU',
          days: ['Sunday', 'Tuesday', 'Thursday'],
          times: ['2:25 PM', '3:35 PM'],
          durationMinutes: 60,
          // No durationMinutes, no slotStates → falls back to DB
          // defaults (60-min countdown, all slots off).
        },
      ],
    },
    // {
    //   name: 'HSC_FINAL_PREPARATION',
    //   fee: 8000,
    //   description: 'Final preparation / model test batch',
    //   hscBatch: 'BATCH_27',
    //   // New cohorts start in ADMISSION — the badge colour flips
    //   // blue until an admin promotes them to ONGOING.
    //   status: 'ADMISSION',
    //   totalSeats: 100,
    //   batchDays: [
    //     {
    //       name: 'SAT-FRI',
    //       days: ['Saturday', 'Monday', 'Wednesday', 'Friday'],
    //       times: ['5:00 PM'],
    //       durationMinutes: 60,
    //     },
    //     {
    //       name: 'SUN-FRI',
    //       days: ['Sunday', 'Tuesday', 'Thursday', 'Friday'],
    //       times: ['6:00 PM'],
    //       durationMinutes: 60,
    //     },
    //   ],
    // },
    // {
    //   name: 'ADMISSION',
    //   fee: 10000,
    //   description: 'University admission preparation',
    //   hscBatch: 'BATCH_27',
    //   status: 'ADMISSION',
    //   totalSeats: 80,
    //   batchDays: [
    //     {
    //       name: 'SUN',
    //       days: ['Sunday', 'Tuesday', 'Thursday'],
    //       times: ['4:00 PM'],
    //       durationMinutes: 75,
    //     },
    //     {
    //       name: 'SAT',
    //       days: ['Saturday', 'Monday', 'Wednesday'],
    //       times: ['10:00 AM', '7:00 PM'],
    //       durationMinutes: 90,
    //       slotStates: [true, false],
    //     },
    //   ],
    // },
  ];

  for (const course of courses) {
    await prisma.$transaction(async (tx) => {
      const existingCourse = await tx.course.findFirst({
        where: { name: course.name },
      });

      let courseRecord;

      if (existingCourse) {
        // Keep the update path idempotent: every field that appears
        // in the seed (including the lifecycle flags + totalSeats) is
        // written so a re-run after a schema change converges to the
        // latest intent. We never touch `completedAt` / `completedBy`
        // here — those are stamped only on the COMPLETE transition
        // via the dedicated endpoint.
        courseRecord = await tx.course.update({
          where: { id: existingCourse.id },
          data: {
            fee: new Prisma.Decimal(course.fee),
            description: course.description,
            isActive: true,
            hscBatch: course.hscBatch,
            status: course.status,
            // Gate follows status, same as setStatusToDB:
            //   COMPLETE → flag on (re-admission allowed).
            //   anything else → flag off.
            isAllowAdmitAnotherCourse: course.status === 'COMPLETE',
            totalSeats: course.totalSeats,
          },
        });
        console.log(`Updated course: ${course.name}`);
      } else {
        courseRecord = await tx.course.create({
          data: {
            name: course.name,
            fee: new Prisma.Decimal(course.fee),
            description: course.description,
            hscBatch: course.hscBatch,
            isActive: true,
            status: course.status,
            isAllowAdmitAnotherCourse: course.status === 'COMPLETE',
            totalSeats: course.totalSeats,
          },
        });
        console.log(`Created course: ${course.name}`);
      }

      // Wipe + recreate the BatchDay rows so the seeded schedule
      // matches the latest catalog exactly. We delete-and-recreate
      // (rather than upsert) because BatchDay rows here are seed
      // artefacts — no real StudentBatches reference them, so a
      // hard delete is safe and keeps the seed idempotent across
      // schema evolutions (e.g. a new field on BatchDay).
      await tx.batchDay.deleteMany({
        where: { courseId: courseRecord.id },
      });

      await tx.batchDay.createMany({
        data: course.batchDays.map((day, position) => ({
          courseId: courseRecord.id,
          name: day.name,
          days: day.days,
          times: day.times,
          position,
          // `durationMinutes` is optional in the type — only
          // written when the seed provides one, so a row without
          // a value exercises the legacy 60-min fallback path.
          ...(day.durationMinutes !== undefined ? { durationMinutes: day.durationMinutes } : {}),
          // Pad to match `times.length`. When omitted the row
          // gets all-false (scanner off + default 5-min window),
          // which is the safe baseline — the admin flips the
          // active slot ON from the Courses page when class
          // starts.
          slotStates: normaliseSlotStates(day.slotStates, day.times.length),
          manualWindowOverride: normaliseBooleanArray(
            day.manualWindowOverride,
            day.times.length,
            false,
          ),
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
