import { Octokit } from '@octokit/rest';

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  updated_at: string;
}

export interface RateLimitInfo {
  remaining: number;
  resetAt: Date;
  limit: number;
}

export class RateLimitError extends Error {
  constructor(
    public resetAt: Date,
    message = 'GitHub rate limit exceeded'
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export class GitHubClient {
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private lastRateLimit: RateLimitInfo | null = null;

  constructor(token: string, owner: string, repo: string) {
    this.octokit = new Octokit({ auth: token });
    this.owner = owner;
    this.repo = repo;
  }

  getRateLimitInfo(): RateLimitInfo | null {
    return this.lastRateLimit;
  }

  private updateRateLimit(headers: Record<string, unknown>): void {
    const remaining = headers['x-ratelimit-remaining'];
    const reset = headers['x-ratelimit-reset'];
    const limit = headers['x-ratelimit-limit'];

    if (remaining !== undefined && reset !== undefined) {
      this.lastRateLimit = {
        remaining: parseInt(String(remaining), 10),
        resetAt: new Date(parseInt(String(reset), 10) * 1000),
        limit: parseInt(String(limit || '60'), 10),
      };
    }
  }

  private async withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await fn();
        return result;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));

        const status = (error as { status?: number })?.status;
        const headers = (error as { response?: { headers?: Record<string, unknown> } })?.response?.headers;

        if (headers) {
          this.updateRateLimit(headers);
        }

        if (status === 429) {
          const resetHeader = headers?.['x-ratelimit-reset'];
          const resetAt = resetHeader
            ? new Date(parseInt(String(resetHeader), 10) * 1000)
            : new Date(Date.now() + 60000);

          if (attempt < retries) {
            const waitMs = Math.max(resetAt.getTime() - Date.now(), 1000 * Math.pow(2, attempt));
            console.log(`Rate limited. Waiting ${waitMs}ms before retry ${attempt + 1}/${retries}`);
            await sleep(waitMs);
            continue;
          }
          throw new RateLimitError(resetAt);
        }

        if (status === 403) {
          const remaining = headers?.['x-ratelimit-remaining'];
          const isRateLimited = remaining === '0' || remaining === 0;
          if (isRateLimited && attempt < retries) {
            const resetHeader = headers?.['x-ratelimit-reset'];
            const resetAt = resetHeader
              ? new Date(parseInt(String(resetHeader), 10) * 1000)
              : new Date(Date.now() + 60000);
            const waitMs = Math.max(resetAt.getTime() - Date.now(), 1000 * Math.pow(2, attempt));
            console.log(`Rate limited (403). Waiting ${waitMs}ms before retry ${attempt + 1}/${retries}`);
            await sleep(waitMs);
            continue;
          }
          // Permission error — fail immediately with clear message
          const message = (error as { message?: string })?.message || 'GitHub permission denied (403)';
          throw new Error(
            `${message}. Check GITHUB_TOKEN has Issues read/write access to the repo.`
          );
        }

        if (status && status >= 500 && attempt < retries) {
          const waitMs = 1000 * Math.pow(2, attempt);
          console.log(`Server error ${status}. Retrying in ${waitMs}ms`);
          await sleep(waitMs);
          continue;
        }

        throw lastError;
      }
    }

    throw lastError!;
  }

  async listIssues(page = 1, perPage = 100, since?: string): Promise<{ issues: GitHubIssue[]; hasMore: boolean }> {
    const response = await this.withRetry(() =>
      this.octokit.issues.listForRepo({
        owner: this.owner,
        repo: this.repo,
        state: 'all',
        page,
        per_page: perPage,
        since,
        sort: 'updated',
        direction: 'asc',
      })
    );

    this.updateRateLimit(response.headers as Record<string, unknown>);

    const issues = response.data
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? null,
        state: issue.state as 'open' | 'closed',
        updated_at: issue.updated_at,
      }));

    return {
      issues,
      hasMore: response.data.length === perPage,
    };
  }

  async getIssue(issueNumber: number): Promise<GitHubIssue> {
    const response = await this.withRetry(() =>
      this.octokit.issues.get({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
      })
    );

    this.updateRateLimit(response.headers as Record<string, unknown>);

    const issue = response.data;
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? null,
      state: issue.state as 'open' | 'closed',
      updated_at: issue.updated_at,
    };
  }

  async createIssue(title: string, body: string): Promise<GitHubIssue> {
    const response = await this.withRetry(() =>
      this.octokit.issues.create({
        owner: this.owner,
        repo: this.repo,
        title,
        body,
      })
    );

    this.updateRateLimit(response.headers as Record<string, unknown>);

    const issue = response.data;
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? null,
      state: issue.state as 'open' | 'closed',
      updated_at: issue.updated_at,
    };
  }

  async updateIssue(
    issueNumber: number,
    updates: { title?: string; body?: string; state?: 'open' | 'closed' }
  ): Promise<GitHubIssue> {
    const response = await this.withRetry(() =>
      this.octokit.issues.update({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        ...updates,
      })
    );

    this.updateRateLimit(response.headers as Record<string, unknown>);

    const issue = response.data;
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? null,
      state: issue.state as 'open' | 'closed',
      updated_at: issue.updated_at,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
