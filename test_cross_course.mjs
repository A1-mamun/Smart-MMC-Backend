import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Reset all slot states to all-ON
const allBDs = await prisma.batchDay.findMany({
  select: { id: true, times: true, slotStates: true },
});
for (const bd of allBDs) {
  await prisma.batchDay.update({
    where: { id: bd.id },
    data: { slotStates: bd.times.map(() => true) },
  });
}
console.log('Reset all slots to ON.');

// Login
const loginRes = await fetch('http://localhost:5002/api/v1/auth/sign-in', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mobile: '01700000000', password: 'Demo@123' }),
});
const authToken = (await loginRes.json()).data?.accessToken;

const courses = await prisma.course.findMany({
  where: { isDeleted: false },
  include: { batchDays: { orderBy: [{ name: 'asc' }] } },
  orderBy: { name: 'asc' },
});
console.log(`\nFound ${courses.length} courses. Showing first BatchDay of each:`);
for (const c of courses) {
  const bd = c.batchDays[0];
  console.log(`  ${c.name} (status=${c.status}): ${bd?.name} | times=${JSON.stringify(bd?.times)} | id=${bd?.id?.slice(0, 8)}`);
}

// Pick two different courses' first BatchDay and toggle their slot 0 ON
const c1 = courses[0]; // HSC_1ST_YEAR
const c2 = courses[1]; // HSC_2ND_YEAR
const bd1 = c1.batchDays[0];
const bd2 = c2.batchDays[0];

console.log(`\n=== Toggle slot 0 of ${c1.name} (${bd1.name}) ON ===`);
const r1 = await fetch(`http://localhost:5002/api/v1/course/${c1.id}/slot-toggle`, {
  method: 'PATCH',
  headers: { 'authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ batchDayId: bd1.id, slotIndex: 0, enabled: true }),
});
const d1 = await r1.json();
console.log(`Status: ${r1.status}, Success: ${d1.success}`);

// Show all slot states
console.log('\n=== All BatchDay slot states after toggling course 1 slot 0 ===');
const states1 = await prisma.batchDay.findMany({
  select: { id: true, name: true, times: true, slotStates: true, course: { select: { name: true } } },
  orderBy: [{ course: { name: 'asc' } }, { name: 'asc' }],
});
for (const bd of states1) {
  console.log(`  ${bd.course.name} | ${bd.name}: ${JSON.stringify(bd.slotStates)}`);
}

console.log(`\n=== Toggle slot 0 of ${c2.name} (${bd2.name}) ON ===`);
const r2 = await fetch(`http://localhost:5002/api/v1/course/${c2.id}/slot-toggle`, {
  method: 'PATCH',
  headers: { 'authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ batchDayId: bd2.id, slotIndex: 0, enabled: true }),
});
const d2 = await r2.json();
console.log(`Status: ${r2.status}, Success: ${d2.success}`);

console.log('\n=== All BatchDay slot states after toggling course 2 slot 0 (should disable course 1) ===');
const states2 = await prisma.batchDay.findMany({
  select: { id: true, name: true, times: true, slotStates: true, course: { select: { name: true } } },
  orderBy: [{ course: { name: 'asc' } }, { name: 'asc' }],
});
for (const bd of states2) {
  console.log(`  ${bd.course.name} | ${bd.name}: ${JSON.stringify(bd.slotStates)}`);
}

// Count total ON slots
let onCount = 0;
for (const bd of states2) {
  for (const s of bd.slotStates) if (s) onCount++;
}
console.log(`\nTotal ON slots: ${onCount} (expected: exactly 1)`);

await prisma.$disconnect();