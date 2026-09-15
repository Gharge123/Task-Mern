import { Router, Request, Response, NextFunction } from 'express';
import { SyncStatus } from '@prisma/client';
import {
  createTask,
  updateTask,
  deleteTask,
  getTask,
  listTasks,
  resolveConflict,
  VersionConflictError,
  TaskNotFoundError,
} from '../services/task-service';
import { SyncEngine } from '../services/sync-engine';
import { handleWebhook } from '../services/webhook-handler';

function paramId(req: Request): string {
  const id = req.params.id;
  return Array.isArray(id) ? id[0] : id;
}

export function createTaskRouter(syncEngine: SyncEngine): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { search, syncStatus, page, limit } = req.query;
      const result = await listTasks({
        search: search as string,
        syncStatus: syncStatus as SyncStatus,
        page: page ? parseInt(page as string, 10) : undefined,
        limit: limit ? parseInt(limit as string, 10) : undefined,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const task = await getTask(paramId(req));
      if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      res.json(task);
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { title, description, status } = req.body;
      if (!title || typeof title !== 'string') {
        res.status(400).json({ error: 'Title is required' });
        return;
      }
      const task = await createTask({ title, description, status });
      res.status(201).json(task);
    } catch (error) {
      next(error);
    }
  });

  router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { title, description, status, version } = req.body;
      if (version === undefined) {
        res.status(400).json({ error: 'Version is required for optimistic locking' });
        return;
      }
      const task = await updateTask(paramId(req), { title, description, status, version });
      res.json(task);
    } catch (error) {
      if (error instanceof VersionConflictError) {
        res.status(409).json({
          error: 'Version conflict',
          message: 'Task was modified by another request. Please refresh and retry.',
          currentVersion: error.currentVersion,
        });
        return;
      }
      if (error instanceof TaskNotFoundError) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      next(error);
    }
  });

  router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const version = parseInt(req.query.version as string, 10);
      if (isNaN(version)) {
        res.status(400).json({ error: 'Version query parameter is required' });
        return;
      }
      await deleteTask(paramId(req), version);
      res.status(204).send();
    } catch (error) {
      if (error instanceof VersionConflictError) {
        res.status(409).json({
          error: 'Version conflict',
          currentVersion: error.currentVersion,
        });
        return;
      }
      if (error instanceof TaskNotFoundError) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      next(error);
    }
  });

  router.post('/:id/resolve-conflict', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { resolution, mergedData } = req.body;
      if (!['KEEP_LOCAL', 'KEEP_REMOTE', 'MERGED'].includes(resolution)) {
        res.status(400).json({ error: 'Invalid resolution. Use KEEP_LOCAL, KEEP_REMOTE, or MERGED' });
        return;
      }
      const task = await resolveConflict(paramId(req), resolution, mergedData);
      res.json(task);
    } catch (error) {
      if (error instanceof TaskNotFoundError) {
        res.status(404).json({ error: 'Task not found or not in conflict state' });
        return;
      }
      next(error);
    }
  });

  return router;
}

export function createSyncRouter(syncEngine: SyncEngine): Router {
  const router = Router();

  router.get('/status', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const status = await syncEngine.getSyncStatus();
      res.json(status);
    } catch (error) {
      next(error);
    }
  });

  router.post('/trigger', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await syncEngine.triggerFullSync();
      res.json({ message: 'Sync completed', ...result });
    } catch (error) {
      if (error instanceof Error && error.message === 'Sync already in progress') {
        res.status(409).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  router.post('/process-queue', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await syncEngine.processOutboundQueue();
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export function createWebhookRouter(syncEngine: SyncEngine): Router {
  const router = Router();

  router.post('/github', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const deliveryId = req.headers['x-github-delivery'] as string;
      const eventType = req.headers['x-github-event'] as string;

      if (!deliveryId) {
        res.status(400).json({ error: 'Missing X-GitHub-Delivery header' });
        return;
      }

      const result = await handleWebhook(deliveryId, eventType, req.body, syncEngine);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
