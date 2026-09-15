import { PrismaClient, SyncStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database with sample tasks...');
  const tasks = [
    { id: '00000000-0000-4000-8000-000000000001', title: 'Test local task', description: 'Sample task created from the PostgreSQL seed script.', status: 'open' },
    { id: '00000000-0000-4000-8000-000000000002', title: 'GitHub sync test', description: 'Use this task to test outbound synchronization with GitHub Issues.', status: 'open' },
  ];
  for (const task of tasks) {
    await prisma.task.upsert({
      where: { id: task.id },
      create: { ...task, syncStatus: SyncStatus.SYNCED },
      update: { title: task.title, description: task.description, status: task.status },
    });
  }
  const count = await prisma.task.count();
  console.log(`✅ Database contains ${count} task(s).`);
}

main().catch((error) => { console.error('❌ Database seed failed:', error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
