import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { config, validateConfig } from './config';
import { GitHubClient } from './services/github-client';
import { SyncEngine } from './services/sync-engine';
import { createTaskRouter, createSyncRouter, createWebhookRouter } from './routes';

validateConfig();

const app = express();
const github = new GitHubClient(config.github.token, config.github.owner, config.github.repo);
const syncEngine = new SyncEngine(github);

app.use(cors());
app.use(express.json());

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/tasks', createTaskRouter(syncEngine));
app.use('/api/sync', createSyncRouter(syncEngine));
app.use('/api/webhooks', createWebhookRouter(syncEngine));

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

const PORT = config.port;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    syncEngine.startPolling();
    syncEngine.processOutboundQueue().catch((err) =>
      console.error('Initial queue processing failed:', err)
    );

    // Import existing GitHub Issues into PostgreSQL on startup.
    syncEngine.triggerFullSync().then((result) => {
      console.log(`Initial GitHub sync completed: ${result.synced} synced, ${result.failed} failed`);
    }).catch((err) => {
      console.error('Initial GitHub sync failed:', err instanceof Error ? err.message : err);
      console.error('API remains available. Check GITHUB_TOKEN/OWNER/REPO and retry POST /api/sync/trigger.');
    });
  });
}

export { app, syncEngine, github };
