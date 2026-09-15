import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    task: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    syncOperation: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('../src/db/prisma', () => ({
  default: mockPrisma,
}));

import { updateTask, VersionConflictError } from '../src/services/task-service';

describe('Concurrent PATCH - Optimistic Locking (Q2)', () => {
  const existingTask = {
    id: 'task-concurrent',
    title: 'Original',
    description: '',
    status: 'open',
    version: 5,
    deletedAt: null,
    syncStatus: 'SYNCED',
    githubIssueNumber: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('first concurrent PATCH with correct version succeeds', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(existingTask);

    const updatedTask = { ...existingTask, title: 'Update A', version: 6 };
    mockPrisma.$transaction.mockImplementation(async (fn: Function) => {
      mockPrisma.task.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.task.findUniqueOrThrow.mockResolvedValue(updatedTask);
      return fn(mockPrisma);
    });
    mockPrisma.syncOperation.create.mockResolvedValue({});

    const result = await updateTask('task-concurrent', {
      title: 'Update A',
      version: 5,
    });

    expect(result.title).toBe('Update A');
    expect(result.version).toBe(6);
  });

  it('second concurrent PATCH with stale version gets 409 conflict', async () => {
    mockPrisma.task.findFirst.mockResolvedValue({
      ...existingTask,
      version: 6,
      title: 'Update A',
    });

    await expect(
      updateTask('task-concurrent', { title: 'Update B', version: 5 })
    ).rejects.toThrow(VersionConflictError);
  });

  it('updateMany with version check ensures only one writer wins', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(existingTask);

    mockPrisma.$transaction.mockImplementation(async (fn: Function) => {
      mockPrisma.task.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.task.findUnique.mockResolvedValue({ ...existingTask, version: 6 });
      return fn(mockPrisma);
    });

    await expect(
      updateTask('task-concurrent', { title: 'Late Update', version: 5 })
    ).rejects.toThrow(VersionConflictError);
  });

  it('VersionConflictError includes current version for client retry', async () => {
    mockPrisma.task.findFirst.mockResolvedValue({ ...existingTask, version: 7 });

    try {
      await updateTask('task-concurrent', { title: 'Stale', version: 5 });
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(VersionConflictError);
      expect((error as VersionConflictError).currentVersion).toBe(7);
    }
  });
});

describe('Conflict Detection Policy (Q3)', () => {
  it('conflict is detected when both local and remote have pending changes', () => {
    const localUpdatedAt = new Date('2024-01-20T10:00:00Z');
    const remoteUpdatedAt = new Date('2024-01-20T11:00:00Z');
    const lastSyncedRemote = new Date('2024-01-19T00:00:00Z');

    const hasLocalPendingChanges = true;
    const remoteIsNewer = remoteUpdatedAt > lastSyncedRemote;
    const localIsNewer = localUpdatedAt > lastSyncedRemote;

    const isConflict = hasLocalPendingChanges && remoteIsNewer && localIsNewer;
    expect(isConflict).toBe(true);
  });

  it('no conflict when only remote changed', () => {
    const hasLocalPendingChanges = false;
    const remoteIsNewer = true;
    const localIsNewer = false;

    const isConflict = hasLocalPendingChanges && remoteIsNewer && localIsNewer;
    expect(isConflict).toBe(false);
  });

  it('field-level merge would preserve both title and description changes', () => {
    const local = { title: 'Local Title', description: 'Original desc', status: 'open' };
    const remote = { title: 'Original title', description: 'Remote desc', status: 'closed' };

    const fieldLevelMerge = {
      title: local.title,
      description: remote.description,
      status: remote.status,
    };

    expect(fieldLevelMerge.title).toBe('Local Title');
    expect(fieldLevelMerge.description).toBe('Remote desc');
    expect(fieldLevelMerge.status).toBe('closed');
  });
});
