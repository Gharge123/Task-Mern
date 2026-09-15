import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  databaseUrl: process.env.DATABASE_URL || '',
  github: {
    token: process.env.GITHUB_TOKEN || '',
    owner: process.env.GITHUB_OWNER || '',
    repo: process.env.GITHUB_REPO || '',
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || '',
  },
  sync: {
    batchSize: parseInt(process.env.SYNC_BATCH_SIZE || '50', 10),
    maxRetries: parseInt(process.env.SYNC_MAX_RETRIES || '5', 10),
    pollIntervalMs: parseInt(process.env.SYNC_POLL_INTERVAL_MS || '60000', 10),
  },
};

export function validateConfig(): void {
  const missing: string[] = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.github.token) missing.push('GITHUB_TOKEN');
  if (!config.github.owner) missing.push('GITHUB_OWNER');
  if (!config.github.repo) missing.push('GITHUB_REPO');

  if (missing.length > 0) {
    console.warn(`Warning: Missing env vars: ${missing.join(', ')}. Some features may not work.`);
  }
}
