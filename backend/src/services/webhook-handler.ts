import { SyncDirection, SyncOpStatus, SyncStatus } from '@prisma/client';
import prisma from '../db/prisma';
import { SyncEngine } from './sync-engine';
import { GitHubIssue } from './github-client';

export interface WebhookPayload {
  action: string;
  issue?: {
    number: number;
    title: string;
    body: string | null;
    state: string;
    updated_at: string;
  };
}

/**
 * Handles GitHub webhook events with idempotency.
 *
 * Q1 Answer: When a webhook is delivered 3 times and the user deleted the task:
 * 1. First delivery: processed normally (or skipped if task already deleted)
 * 2. Second & third deliveries: deduplicated via deliveryId in webhook_events table
 * 3. If task was deleted locally (deletedAt set), applyRemoteWebhook returns early
 *    without recreating the task — see lines 52-58 below
 */
export async function handleWebhook(
  deliveryId: string,
  eventType: string,
  payload: WebhookPayload,
  syncEngine: SyncEngine
): Promise<{ processed: boolean; reason: string }> {
  const existing = await prisma.webhookEvent.findUnique({
    where: { deliveryId },
  });

  if (existing) {
    return { processed: false, reason: 'duplicate_delivery' };
  }

  await prisma.webhookEvent.create({
    data: {
      deliveryId,
      eventType,
      action: payload.action,
      payload: payload as object,
    },
  });

  if (eventType !== 'issues' || !payload.issue) {
    await markWebhookProcessed(deliveryId, 'ignored_non_issue_event');
    return { processed: false, reason: 'ignored_non_issue_event' };
  }

  const issueNumber = payload.issue.number;

  const localTask = await prisma.task.findFirst({
    where: { githubIssueNumber: issueNumber },
  });

  if (localTask?.deletedAt) {
    await markWebhookProcessed(deliveryId, 'task_deleted_locally');
    return { processed: false, reason: 'task_deleted_locally' };
  }

  const idempotencyKey = `webhook:${deliveryId}:${payload.action}:${issueNumber}`;

  const existingOp = await prisma.syncOperation.findUnique({
    where: { idempotencyKey },
  });

  if (existingOp) {
    await markWebhookProcessed(deliveryId, 'duplicate_operation');
    return { processed: false, reason: 'duplicate_operation' };
  }

  if (payload.action === 'deleted') {
    if (localTask && !localTask.deletedAt) {
      await prisma.task.update({
        where: { id: localTask.id },
        data: {
          deletedAt: new Date(),
          syncStatus: SyncStatus.SYNCED,
          version: { increment: 1 },
        },
      });
    }
    await markWebhookProcessed(deliveryId, 'issue_deleted');
    return { processed: true, reason: 'issue_deleted' };
  }

  if (['opened', 'edited', 'closed', 'reopened'].includes(payload.action)) {
    const issue: GitHubIssue = {
      number: payload.issue.number,
      title: payload.issue.title,
      body: payload.issue.body,
      state: payload.issue.state as 'open' | 'closed',
      updated_at: payload.issue.updated_at,
    };

    if (localTask) {
      await prisma.syncOperation.create({
        data: {
          taskId: localTask.id,
          direction: SyncDirection.FROM_PROVIDER,
          operation: 'WEBHOOK_UPDATE',
          payload: issue as object,
          idempotencyKey,
          status: SyncOpStatus.PENDING,
        },
      });

      await syncEngine.applyRemoteIssue(issue);
    } else {
      await syncEngine.applyRemoteIssue(issue);
    }

    await markWebhookProcessed(deliveryId, 'issue_synced');
    return { processed: true, reason: 'issue_synced' };
  }

  await markWebhookProcessed(deliveryId, 'unhandled_action');
  return { processed: false, reason: 'unhandled_action' };
}

async function markWebhookProcessed(deliveryId: string, result: string): Promise<void> {
  await prisma.webhookEvent.update({
    where: { deliveryId },
    data: { processed: true, processedAt: new Date(), result },
  });
}

export async function isWebhookDuplicate(deliveryId: string): Promise<boolean> {
  const existing = await prisma.webhookEvent.findUnique({
    where: { deliveryId },
  });
  return !!existing;
}
