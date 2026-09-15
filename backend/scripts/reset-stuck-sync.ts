import prisma from '../src/db/prisma';
import { SyncOpStatus } from '@prisma/client';

async function main() {
  const reset = await prisma.syncOperation.updateMany({
    where: { status: SyncOpStatus.IN_PROGRESS },
    data: { status: SyncOpStatus.PENDING, retryCount: 0 },
  });
  console.log(`Reset ${reset.count} stuck sync operation(s)`);

  const ops = await prisma.syncOperation.findMany({
    select: { id: true, status: true, operation: true, lastError: true, retryCount: true },
  });
  console.log('Current sync operations:', ops);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
