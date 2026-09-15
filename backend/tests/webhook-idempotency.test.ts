import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SyncStatus } from '@prisma/client';

const { mockPrisma, mockSyncEngine } = vi.hoisted(() => ({
  mockPrisma: {
    webhookEvent: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    task: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    syncOperation: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
  mockSyncEngine: {
    applyRemoteIssue: vi.fn(),
  },
}));

vi.mock('../src/db/prisma', () => ({
  default: mockPrisma,
}));

import { handleWebhook, isWebhookDuplicate } from '../src/services/webhook-handler';

describe('Webhook Idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reject duplicate webhook deliveries by deliveryId', async () => {
    mockPrisma.webhookEvent.findUnique.mockResolvedValue({
      id: 'existing',
      deliveryId: 'delivery-123',
      processed: true,
    });

    const result = await handleWebhook(
      'delivery-123',
      'issues',
      { action: 'opened', issue: { number: 1, title: 'Test', body: '', state: 'open', updated_at: '2024-01-01' } },
      mockSyncEngine as any
    );

    expect(result.processed).toBe(false);
    expect(result.reason).toBe('duplicate_delivery');
    expect(mockPrisma.webhookEvent.create).not.toHaveBeenCalled();
  });

  it('should ignore webhook when task was deleted locally (Q1 scenario)', async () => {
    mockPrisma.webhookEvent.findUnique.mockResolvedValue(null);
    mockPrisma.webhookEvent.create.mockResolvedValue({});
    mockPrisma.webhookEvent.update.mockResolvedValue({});

    mockPrisma.task.findFirst.mockResolvedValue({
      id: 'task-1',
      githubIssueNumber: 42,
      deletedAt: new Date('2024-01-15'),
      title: 'Deleted Task',
    });

    const result = await handleWebhook(
      'delivery-456',
      'issues',
      {
        action: 'edited',
        issue: { number: 42, title: 'Updated on GitHub', body: 'new body', state: 'open', updated_at: '2024-01-20' },
      },
      mockSyncEngine as any
    );

    expect(result.processed).toBe(false);
    expect(result.reason).toBe('task_deleted_locally');
    expect(mockSyncEngine.applyRemoteIssue).not.toHaveBeenCalled();
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
  });

  it('should process first delivery and deduplicate subsequent ones', async () => {
    const deliveryId = 'delivery-triple';

    mockPrisma.webhookEvent.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: '1', deliveryId, processed: true });

    mockPrisma.webhookEvent.create.mockResolvedValue({});
    mockPrisma.webhookEvent.update.mockResolvedValue({});
    mockPrisma.task.findFirst.mockResolvedValue({
      id: 'task-2',
      githubIssueNumber: 10,
      deletedAt: null,
    });
    mockPrisma.syncOperation.findUnique.mockResolvedValue(null);
    mockPrisma.syncOperation.create.mockResolvedValue({});
    mockSyncEngine.applyRemoteIssue.mockResolvedValue(undefined);

    const payload = {
      action: 'edited',
      issue: { number: 10, title: 'Edit', body: '', state: 'open', updated_at: '2024-01-01' },
    };

    const first = await handleWebhook(deliveryId, 'issues', payload, mockSyncEngine as any);
    expect(first.processed).toBe(true);

    const second = await handleWebhook(deliveryId, 'issues', payload, mockSyncEngine as any);
    expect(second.processed).toBe(false);
    expect(second.reason).toBe('duplicate_delivery');
  });

  it('isWebhookDuplicate returns true for seen delivery IDs', async () => {
    mockPrisma.webhookEvent.findUnique.mockResolvedValue({ deliveryId: 'seen-1' });
    expect(await isWebhookDuplicate('seen-1')).toBe(true);

    mockPrisma.webhookEvent.findUnique.mockResolvedValue(null);
    expect(await isWebhookDuplicate('new-1')).toBe(false);
  });
});

describe('Webhook deleted task scenario - triple delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('all 3 deliveries after local delete are safely ignored', async () => {
    const deletedTask = {
      id: 'task-deleted',
      githubIssueNumber: 99,
      deletedAt: new Date(),
      syncStatus: SyncStatus.SYNCED,
    };

    for (let i = 1; i <= 3; i++) {
      mockPrisma.webhookEvent.findUnique.mockResolvedValue(
        i === 1 ? null : { deliveryId: `delivery-${i}`, processed: true }
      );
      mockPrisma.webhookEvent.create.mockResolvedValue({});
      mockPrisma.webhookEvent.update.mockResolvedValue({});
      mockPrisma.task.findFirst.mockResolvedValue(deletedTask);

      const result = await handleWebhook(
        `delivery-${i}`,
        'issues',
        {
          action: 'edited',
          issue: { number: 99, title: 'Should not apply', body: '', state: 'open', updated_at: '2024-01-01' },
        },
        mockSyncEngine as any
      );

      if (i === 1) {
        expect(result.reason).toBe('task_deleted_locally');
      }
      expect(mockSyncEngine.applyRemoteIssue).not.toHaveBeenCalled();
    }
  });
});
