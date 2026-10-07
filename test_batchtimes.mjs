import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const days = await prisma.batchDay.findMany({
  take: 10,
  select: { id: true, name: true, days: true, times: true, course: { select: { name: true, hscBatch: true, isActive: true } } },
});
console.log('BatchDay samples:');
for (const d of days) {
  console.log(` - course=${d.course.name} | name=${d.name} | days=${JSON.stringify(d.days)} | times=${JSON.stringify(d.times)} | active=${d.course.isActive}`);
}
await prisma.$disconnect();