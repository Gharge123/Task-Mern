import { Prisma, SyncStatus, Task } from '@prisma/client';
import prisma from '../db/prisma';

export interface TaskInput {
  title: string;
  description?: string;
  status?: string;
}

export interface TaskUpdateInput {
  title?: string;
  description?: string;
  status?: string;
  version: number;
}

export class VersionConflictError extends Error {
  constructor(public currentVersion: number) {
    super(`Version conflict: expected different version, current is ${currentVersion}`);
    this.name = 'VersionConflictError';
  }
}

export class TaskNotFoundError extends Error {
  constructor(id: string) {
    super(`Task not found: ${id}`);
    this.name = 'TaskNotFoundError';
  }
}

export async function createTask(input: TaskInput): Promise<Task> {
  const task = await prisma.task.create({
    data: {
      title: input.title,
      description: input.description || '',
      status: input.status || 'open',
      syncStatus: SyncStatus.PENDING,
      localUpdatedAt: new Date(),
    },
  });

  await enqueueSyncOperation(task.id, 'CREATE', {
    title: task.title,
    description: task.description,
    status: task.status,
  });

  return task;
}

export async function updateTask(id: string, input: TaskUpdateInput): Promise<Task> {
  const existing = await prisma.task.findFirst({
    where: { id, deletedAt: null },
  });

  if (!existing) {
    throw new TaskNotFoundError(id);
  }

  if (existing.version !== input.version) {
    throw new VersionConflictError(existing.version);
  }

  const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const result = await tx.task.updateMany({
      where: { id, version: input.version, deletedAt: null },
      data: {
        title: input.title ?? existing.title,
        description: input.description ?? existing.description,
        status: input.status ?? existing.status,
        version: { increment: 1 },
        localUpdatedAt: new Date(),
        syncStatus: existing.syncStatus === SyncStatus.CONFLICT ? SyncStatus.CONFLICT : SyncStatus.PENDING,
        updatedAt: new Date(),
      },
    });

    if (result.count === 0) {
      const current = await tx.task.findUnique({ where: { id } });
      throw new VersionConflictError(current?.version ?? 0);
    }

    return tx.task.findUniqueOrThrow({ where: { id } });
  });

  if (updated.syncStatus !== SyncStatus.CONFLICT) {
    await enqueueSyncOperation(updated.id, 'UPDATE', {
      title: updated.title,
      description: updated.description,
      status: updated.status,
      githubIssueNumber: updated.githubIssueNumber,
    });
  }

  return updated;
}

export async function deleteTask(id: string, version: number): Promise<void> {
  const existing = await prisma.task.findFirst({
    where: { id, deletedAt: null },
  });

  if (!existing) {
    throw new TaskNotFoundError(id);
  }

  if (existing.version !== version) {
    throw new VersionConflictError(existing.version);
  }

  await prisma.$transaction(async (tx) => {
    const result = await tx.task.updateMany({
      where: { id, version, deletedAt: null },
      data: {
        deletedAt: new Date(),
        version: { increment: 1 },
        syncStatus: SyncStatus.PENDING,
        localUpdatedAt: new Date(),
      },
    });

    if (result.count === 0) {
      const current = await tx.task.findUnique({ where: { id } });
      throw new VersionConflictError(current?.version ?? 0);
    }
  });

  if (existing.githubIssueNumber) {
    await enqueueSyncOperation(id, 'DELETE', {
      githubIssueNumber: existing.githubIssueNumber,
    });
  }
}

export async function getTask(id: string): Promise<Task | null> {
  return prisma.task.findFirst({
    where: { id, deletedAt: null },
  });
}

export interface TaskListQuery {
  search?: string;
  syncStatus?: SyncStatus;
  page?: number;
  limit?: number;
}

export async function listTasks(query: TaskListQuery = {}) {
  const page = query.page || 1;
  const limit = Math.min(query.limit || 20, 100);
  const skip = (page - 1) * limit;

  const where: Prisma.TaskWhereInput = {
    deletedAt: null,
    ...(query.syncStatus && { syncStatus: query.syncStatus }),
    ...(query.search && {
      OR: [
        { title: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
      ],
    }),
  };

  const [tasks, total] = await Promise.all([
    prisma.task.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.task.count({ where }),
  ]);

  return {
    tasks,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

async function enqueueSyncOperation(
  taskId: string,
  operation: string,
  payload: Record<string, unknown>
): Promise<void> {
  const idempotencyKey = `${taskId}:${operation}:${Date.now()}`;

  await prisma.syncOperation.create({
    data: {
      taskId,
      direction: 'TO_PROVIDER',
      operation,
      payload: payload as Prisma.InputJsonValue,
      idempotencyKey,
      priority: operation === 'DELETE' ? 10 : 0,
    },
  });
}

export async function resolveConflict(
  id: string,
  resolution: 'KEEP_LOCAL' | 'KEEP_REMOTE' | 'MERGED',
  mergedData?: TaskInput
): Promise<Task> {
  const task = await prisma.task.findFirst({
    where: { id, deletedAt: null, syncStatus: SyncStatus.CONFLICT },
  });

  if (!task) {
    throw new TaskNotFoundError(id);
  }

  let updateData: Prisma.TaskUpdateInput;

  switch (resolution) {
    case 'KEEP_LOCAL':
      updateData = {
        title: task.conflictLocalTitle || task.title,
        description: task.conflictLocalDescription || task.description,
        status: task.conflictLocalStatus || task.status,
        syncStatus: SyncStatus.PENDING,
        conflictLocalTitle: null,
        conflictLocalDescription: null,
        conflictLocalStatus: null,
        conflictRemoteTitle: null,
        conflictRemoteDescription: null,
        conflictRemoteStatus: null,
        conflictDetectedAt: null,
        version: { increment: 1 },
        localUpdatedAt: new Date(),
      };
      break;

    case 'KEEP_REMOTE':
      updateData = {
        title: task.conflictRemoteTitle || task.title,
        description: task.conflictRemoteDescription || task.description,
        status: task.conflictRemoteStatus || task.status,
        syncStatus: SyncStatus.SYNCED,
        conflictLocalTitle: null,
        conflictLocalDescription: null,
        conflictLocalStatus: null,
        conflictRemoteTitle: null,
        conflictRemoteDescription: null,
        conflictRemoteStatus: null,
        conflictDetectedAt: null,
        version: { increment: 1 },
        remoteUpdatedAt: new Date(),
      };
      break;

    case 'MERGED':
      if (!mergedData) {
        throw new Error('Merged data required for MERGED resolution');
      }
      updateData = {
        title: mergedData.title,
        description: mergedData.description || '',
        status: mergedData.status || 'open',
        syncStatus: SyncStatus.PENDING,
        conflictLocalTitle: null,
        conflictLocalDescription: null,
        conflictLocalStatus: null,
        conflictRemoteTitle: null,
        conflictRemoteDescription: null,
        conflictRemoteStatus: null,
        conflictDetectedAt: null,
        version: { increment: 1 },
        localUpdatedAt: new Date(),
      };
      break;
  }

  const updated = await prisma.task.update({
    where: { id },
    data: updateData,
  });

  if (resolution === 'KEEP_LOCAL' || resolution === 'MERGED') {
    await enqueueSyncOperation(updated.id, 'UPDATE', {
      title: updated.title,
      description: updated.description,
      status: updated.status,
      githubIssueNumber: updated.githubIssueNumber,
    });
  }

  return updated;
}
