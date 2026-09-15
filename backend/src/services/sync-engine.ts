import { SyncDirection, SyncOpStatus, SyncStatus, Task } from '@prisma/client';
import prisma from '../db/prisma';
import { config } from '../config';
import { GitHubClient, GitHubIssue, RateLimitError } from './github-client';

const CHECKPOINT_KEY = 'initial_sync_cursor';
const INBOUND_POLL_KEY = 'inbound_poll_since';

export class SyncEngine {
  private github: GitHubClient;
  private isRunning = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(github: GitHubClient) {
    this.github = github;
  }

  startPolling(): void {
    if (this.pollTimer) return;

    const poll = () => {
      this.processOutboundQueue().catch((err) =>
        console.error('Outbound sync error:', err)
      );
      this.pollInboundChanges().catch((err) =>
        console.error('Inbound poll error:', err)
      );
    };

    this.pollTimer = setInterval(poll, config.sync.pollIntervalMs);
    poll();

    console.log(`Sync polling started (interval: ${config.sync.pollIntervalMs}ms)`);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async triggerFullSync(): Promise<{ synced: number; failed: number }> {
    if (this.isRunning) {
      throw new Error('Sync already in progress');
    }

    this.isRunning = true;
    const run = await prisma.syncRun.create({
      data: { type: 'full', status: 'running' },
    });

    let synced = 0;
    let failed = 0;

    try {
      const outboundResult = await this.processOutboundQueue();
      synced += outboundResult.processed;
      failed += outboundResult.failed;

      const inboundResult = await this.runInitialSync();
      synced += inboundResult.synced;
      failed += inboundResult.failed;

      await prisma.syncRun.update({
        where: { id: run.id },
        data: {
          status: 'completed',
          completedAt: new Date(),
          tasksSynced: synced,
          tasksFailed: failed,
        },
      });
    } catch (error) {
      await prisma.syncRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          completedAt: new Date(),
          tasksSynced: synced,
          tasksFailed: failed,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    } finally {
      this.isRunning = false;
    }

    return { synced, failed };
  }

  async processOutboundQueue(): Promise<{ processed: number; failed: number }> {
    let processed = 0;
    let failed = 0;

    // Recover operations stuck in IN_PROGRESS (e.g. after crash or long retry)
    await prisma.syncOperation.updateMany({
      where: {
        status: SyncOpStatus.IN_PROGRESS,
        updatedAt: { lt: new Date(Date.now() - 2 * 60 * 1000) },
      },
      data: { status: SyncOpStatus.PENDING },
    });

    const operations = await prisma.syncOperation.findMany({
      where: {
        status: { in: [SyncOpStatus.PENDING, SyncOpStatus.FAILED] },
        direction: SyncDirection.TO_PROVIDER,
        scheduledAt: { lte: new Date() },
        retryCount: { lt: config.sync.maxRetries },
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      take: config.sync.batchSize,
      include: { task: true },
    });

    for (const op of operations) {
      if (op.task.deletedAt && op.operation !== 'DELETE') {
        await prisma.syncOperation.update({
          where: { id: op.id },
          data: { status: SyncOpStatus.COMPLETED, processedAt: new Date() },
        });
        continue;
      }

      await prisma.syncOperation.update({
        where: { id: op.id },
        data: { status: SyncOpStatus.IN_PROGRESS },
      });

      try {
        await this.executeOutboundOperation(op);
        await prisma.syncOperation.update({
          where: { id: op.id },
          data: { status: SyncOpStatus.COMPLETED, processedAt: new Date() },
        });

        if (op.task.deletedAt === null) {
          await prisma.task.update({
            where: { id: op.taskId },
            data: { syncStatus: SyncStatus.SYNCED },
          });
        }
        processed++;
      } catch (error) {
        const retryCount = op.retryCount + 1;
        const isQuarantined = retryCount >= op.maxRetries;

        await prisma.syncOperation.update({
          where: { id: op.id },
          data: {
            status: isQuarantined ? SyncOpStatus.QUARANTINED : SyncOpStatus.FAILED,
            retryCount,
            lastError: error instanceof Error ? error.message : String(error),
            scheduledAt: new Date(Date.now() + Math.pow(2, retryCount) * 1000),
          },
        });

        if (isQuarantined && op.task.deletedAt === null) {
          await prisma.task.update({
            where: { id: op.taskId },
            data: { syncStatus: SyncStatus.QUARANTINED },
          });
        } else if (!isQuarantined && op.task.deletedAt === null) {
          await prisma.task.update({
            where: { id: op.taskId },
            data: { syncStatus: SyncStatus.ERROR },
          });
        }

        failed++;

        if (error instanceof RateLimitError) {
          console.log(`Rate limit hit, stopping outbound processing until ${error.resetAt}`);
          break;
        }
      }
    }

    return { processed, failed };
  }

  private async executeOutboundOperation(op: {
    operation: string;
    payload: unknown;
    taskId: string;
    task: Task;
  }): Promise<void> {
    const payload = op.payload as Record<string, unknown>;

    switch (op.operation) {
      case 'CREATE': {
        const issue = await this.github.createIssue(
          payload.title as string,
          (payload.description as string) || ''
        );
        await prisma.task.update({
          where: { id: op.taskId },
          data: {
            githubIssueNumber: issue.number,
            githubUpdatedAt: new Date(issue.updated_at),
            remoteUpdatedAt: new Date(issue.updated_at),
            syncStatus: SyncStatus.SYNCED,
          },
        });
        break;
      }

      case 'UPDATE': {
        const issueNumber = payload.githubIssueNumber as number | null;
        if (!issueNumber) {
          const issue = await this.github.createIssue(
            payload.title as string,
            (payload.description as string) || ''
          );
          await prisma.task.update({
            where: { id: op.taskId },
            data: {
              githubIssueNumber: issue.number,
              githubUpdatedAt: new Date(issue.updated_at),
              remoteUpdatedAt: new Date(issue.updated_at),
            },
          });
        } else {
          const issue = await this.github.updateIssue(issueNumber, {
            title: payload.title as string,
            body: (payload.description as string) || '',
            state: (payload.status as string) === 'closed' ? 'closed' : 'open',
          });
          await prisma.task.update({
            where: { id: op.taskId },
            data: {
              githubUpdatedAt: new Date(issue.updated_at),
              remoteUpdatedAt: new Date(issue.updated_at),
            },
          });
        }
        break;
      }

      case 'DELETE': {
        const issueNumber = payload.githubIssueNumber as number;
        if (issueNumber) {
          await this.github.updateIssue(issueNumber, { state: 'closed' });
        }
        break;
      }
    }
  }

  async pollInboundChanges(): Promise<{ synced: number }> {
    let synced = 0;

    const checkpoint = await prisma.syncCheckpoint.findUnique({
      where: { key: INBOUND_POLL_KEY },
    });

    const sinceDate = checkpoint?.cursor
      ? new Date(new Date(checkpoint.cursor).getTime() - 60_000)
      : new Date(Date.now() - 10 * 60 * 1000);
    const since = sinceDate.toISOString();

    const pollStartedAt = new Date().toISOString();

    try {
      const { issues } = await this.github.listIssues(1, config.sync.batchSize, since);

      for (const issue of issues) {
        try {
          await this.applyRemoteIssue(issue);
          synced++;
        } catch (err) {
          console.error(`Inbound poll: failed issue #${issue.number}:`, err);
        }
      }

      await prisma.syncCheckpoint.upsert({
        where: { key: INBOUND_POLL_KEY },
        create: { key: INBOUND_POLL_KEY, cursor: pollStartedAt },
        update: { cursor: pollStartedAt },
      });
    } catch (error) {
      if (error instanceof RateLimitError) {
        console.log('Inbound poll skipped: rate limited');
        return { synced: 0 };
      }
      throw error;
    }

    return { synced };
  }

  async runInitialSync(): Promise<{ synced: number; failed: number }> {
    let synced = 0;
    let failed = 0;
    let page = 1;
    let hasMore = true;

    const checkpoint = await prisma.syncCheckpoint.findUnique({
      where: { key: CHECKPOINT_KEY },
    });

    if (checkpoint?.cursor) {
      page = parseInt(checkpoint.cursor, 10);
    }

    while (hasMore) {
      try {
        const { issues, hasMore: more } = await this.github.listIssues(page, config.sync.batchSize);
        hasMore = more;

        for (const issue of issues) {
          try {
            await this.applyRemoteIssue(issue);
            synced++;
          } catch (err) {
            console.error(`Failed to sync issue #${issue.number}:`, err);
            failed++;
          }
        }

        page++;
        await prisma.syncCheckpoint.upsert({
          where: { key: CHECKPOINT_KEY },
          create: { key: CHECKPOINT_KEY, cursor: String(page) },
          update: { cursor: String(page) },
        });

        if (!hasMore) {
          await prisma.syncCheckpoint.delete({ where: { key: CHECKPOINT_KEY } }).catch(() => {});
        }
      } catch (error) {
        if (error instanceof RateLimitError) {
          await prisma.syncCheckpoint.upsert({
            where: { key: CHECKPOINT_KEY },
            create: { key: CHECKPOINT_KEY, cursor: String(page) },
            update: { cursor: String(page) },
          });
          throw error;
        }
        throw error;
      }
    }

    return { synced, failed };
  }

  async applyRemoteIssue(issue: GitHubIssue): Promise<void> {
    const remoteUpdatedAt = new Date(issue.updated_at);

    const existing = await prisma.task.findFirst({
      where: { githubIssueNumber: issue.number },
    });

    if (!existing) {
      await prisma.task.create({
        data: {
          title: issue.title,
          description: issue.body || '',
          status: issue.state,
          githubIssueNumber: issue.number,
          githubUpdatedAt: remoteUpdatedAt,
          remoteUpdatedAt,
          syncStatus: SyncStatus.SYNCED,
        },
      });
      return;
    }

    if (existing.deletedAt) {
      return;
    }

    const hasLocalPendingChanges = existing.syncStatus === SyncStatus.PENDING;
    const remoteIsNewer =
      !existing.remoteUpdatedAt || remoteUpdatedAt > existing.remoteUpdatedAt;
    const localIsNewer =
      existing.localUpdatedAt > (existing.remoteUpdatedAt || new Date(0));

    if (hasLocalPendingChanges && remoteIsNewer && localIsNewer) {
      await this.markConflict(existing, issue);
      return;
    }

    if (remoteIsNewer && !hasLocalPendingChanges) {
      await prisma.task.update({
        where: { id: existing.id },
        data: {
          title: issue.title,
          description: issue.body || '',
          status: issue.state,
          githubUpdatedAt: remoteUpdatedAt,
          remoteUpdatedAt,
          syncStatus: SyncStatus.SYNCED,
          version: { increment: 1 },
        },
      });
    }
  }

  private async markConflict(existing: Task, remote: GitHubIssue): Promise<void> {
    await prisma.task.update({
      where: { id: existing.id },
      data: {
        syncStatus: SyncStatus.CONFLICT,
        conflictLocalTitle: existing.title,
        conflictLocalDescription: existing.description,
        conflictLocalStatus: existing.status,
        conflictRemoteTitle: remote.title,
        conflictRemoteDescription: remote.body || '',
        conflictRemoteStatus: remote.state,
        conflictDetectedAt: new Date(),
      },
    });
  }

  async getSyncStatus() {
    const [
      pendingOps,
      failedOps,
      quarantinedOps,
      lastRun,
      statusCounts,
      totalTasks,
      rateLimit,
    ] = await Promise.all([
      prisma.syncOperation.count({ where: { status: SyncOpStatus.PENDING } }),
      prisma.syncOperation.count({ where: { status: SyncOpStatus.FAILED } }),
      prisma.syncOperation.count({ where: { status: SyncOpStatus.QUARANTINED } }),
      prisma.syncRun.findFirst({ orderBy: { startedAt: 'desc' } }),
      prisma.task.groupBy({
        by: ['syncStatus'],
        where: { deletedAt: null },
        _count: true,
      }),
      prisma.task.count({ where: { deletedAt: null } }),
      Promise.resolve(this.github.getRateLimitInfo()),
    ]);

    const taskStatusMap: Record<string, number> = {};
    for (const item of statusCounts) {
      taskStatusMap[item.syncStatus] = item._count;
    }

    const checkpoint = await prisma.syncCheckpoint.findUnique({
      where: { key: CHECKPOINT_KEY },
    });

    return {
      isRunning: this.isRunning,
      queue: { pending: pendingOps, failed: failedOps, quarantined: quarantinedOps },
      tasks: taskStatusMap,
      totalTasks,
      lastRun,
      checkpoint: checkpoint?.cursor || null,
      rateLimit,
    };
  }
}
