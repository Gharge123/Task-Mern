# Cross-Tool Task Sync Engine

A bidirectional task synchronization engine between a local PostgreSQL-backed app and GitHub Issues. Built as a full-stack assessment demonstrating correctness under unreliable networks, duplicate events, concurrent edits, and crash recovery.

## Quick Start

### Prerequisites
- Node.js 18+
- Docker (for PostgreSQL)
- GitHub Personal Access Token with `repo` scope

### Setup (single command after cloning)

```bash
# 1. Copy and configure environment
cp backend/.env.example backend/.env
# Edit backend/.env with your GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO

# 2. Install, start DB, migrate, and run
npm run setup
npm run dev
```

- **Backend API**: http://localhost:3001
- **Frontend UI**: http://localhost:5173

### GitHub Webhook Setup (optional, for real-time inbound sync)

1. In your GitHub repo → Settings → Webhooks → Add webhook
2. Payload URL: `http://your-host:3001/api/webhooks/github`
3. Content type: `application/json`
4. Events: **Issues**
5. For local dev, use [ngrok](https://ngrok.com) or [smee.io](https://smee.io) to tunnel

---

## PostgreSQL / pgAdmin 4 Setup

The repository includes a `database/` folder containing SQL scripts for manual PostgreSQL setup:

1. In pgAdmin 4, connect to the PostgreSQL server and open the `postgres` database.
2. Run `database/00_create_database.sql` to create the `tasksync` database. If `tasksync` already exists, skip this file.
3. Connect to the `tasksync` database.
4. Open Query Tool and run `database/01_schema.sql`. This creates all enums, tables, indexes and the foreign key required by the application.
5. Optional: run `database/02_seed_sample_data.sql` to add two development tasks.
6. Set `backend/.env` to point to the same database, for example:

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/tasksync?schema=tasksync_schema"
```

The application uses Prisma, so the SQL schema mirrors `backend/prisma/schema.prisma`. You do not need to run the optional seed script for a production database.

## Architecture

```
┌─────────────┐     REST API      ┌──────────────────┐
│  React UI   │ ◄──────────────► │  Express Server  │
└─────────────┘                   └────────┬─────────┘
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    │                      │                      │
              ┌─────▼─────┐         ┌──────▼──────┐       ┌──────▼──────┐
              │ Task Svc  │         │ Sync Engine │       │  Webhook    │
              │ (CRUD +   │         │ (outbox +   │       │  Handler    │
              │  locking) │         │  checkpoint)│       │ (idempotent)│
              └─────┬─────┘         └──────┬──────┘       └──────┬──────┘
                    │                      │                      │
                    └──────────────────────┼──────────────────────┘
                                           │
                                    ┌──────▼──────┐
                                    │ PostgreSQL  │
                                    │  - tasks    │
                                    │  - sync_ops │
                                    │  - webhooks │
                                    │  - checkpoint│
                                    └──────┬──────┘
                                           │
                                    ┌──────▼──────┐
                                    │ GitHub API  │
                                    │  (Issues)   │
                                    └─────────────┘
```

### Key Design Decisions

| Area | Choice | Rationale |
|------|--------|-----------|
| **Outbound sync** | Outbox pattern (`sync_operations` table) | Guarantees no lost writes; survives crashes |
| **Inbound sync** | Webhooks + polling fallback | Real-time when available; polling catches missed events |
| **Initial sync** | Paginated with checkpoint cursor | Resumable after crash; handles 10k+ issues |
| **Rate limits** | Exponential backoff + respect `X-RateLimit-Reset` | Never fails permanently on 429 |
| **Concurrency** | Optimistic locking (`version` field) | Simple, no distributed locks needed |
| **Conflict policy** | Detect + manual resolve | See below |

### Conflict Resolution Policy

**Policy: Last-Write-Wins with Conflict Detection and Manual Resolution**

When both the local app and GitHub have pending changes to the same task (detected by comparing `localUpdatedAt` and `remoteUpdatedAt` against the last known sync point), the task is marked `CONFLICT` instead of silently overwriting either side.

**Why this policy:**
- **No silent data loss** — unlike pure LWW, the user is always notified
- **Simple to reason about** — no complex field-level merge heuristics that might produce garbage
- **Appropriate for task management** — conflicts are rare in normal usage; when they happen, human judgment is best

**Trade-off (Q3):** A user may feel their edit was "lost" if they choose "Keep Remote" or if they don't notice the conflict UI. The alternative — automatic field-level merge — would preserve more data automatically but can produce nonsensical merged states (e.g., a title from one side and a status from another that don't make sense together). With more time, I'd implement optional field-level merge as a fourth resolution option, using per-field timestamps to pick the newest value for each field independently.

---

## How I Ensured Sync Correctness

### Race Conditions
- **Optimistic locking**: Every `PATCH`/`DELETE` requires a `version` number. The DB update uses `WHERE version = :expected`; if 0 rows match, a `409 Conflict` is returned. This ensures exactly one concurrent writer wins.
- **Transactional updates**: Task updates and version increments happen in a single `$transaction`.
- **Outbound queue ordering**: Operations are processed FIFO with priority for deletes.

### Idempotency
- **Webhooks**: `X-GitHub-Delivery` header is stored in `webhook_events.deliveryId` (unique). Duplicate deliveries are rejected before any processing.
- **Sync operations**: Each operation has a unique `idempotencyKey` (`webhook:{deliveryId}:{action}:{issueNumber}` for inbound).
- **Deleted task + webhook (Q1)**: If a task has `deletedAt` set, `handleWebhook` returns early with `task_deleted_locally` — the task is never recreated. See `backend/src/services/webhook-handler.ts` lines 52-58.

### Retries
- Failed sync operations retry with exponential backoff (`2^retryCount * 1000ms`).
- After `maxRetries` (default 5), operations are **quarantined** — they don't block the rest of the queue.
- Rate limit hits (429) pause processing until the reset time from GitHub headers.

### Resumability
- Initial sync stores a page cursor in `sync_checkpoints`. If the process crashes mid-sync, it resumes from the saved page on restart.
- The outbox pattern means no in-flight local changes are lost on crash — they're picked up on next queue processing.

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tasks` | List tasks (search, filter, paginate) |
| POST | `/api/tasks` | Create task (queues outbound sync) |
| PATCH | `/api/tasks/:id` | Update task (requires `version`) |
| DELETE | `/api/tasks/:id?version=N` | Soft-delete task |
| POST | `/api/tasks/:id/resolve-conflict` | Resolve conflict |
| GET | `/api/sync/status` | Sync engine status |
| POST | `/api/sync/trigger` | Trigger full sync |
| POST | `/api/webhooks/github` | GitHub webhook receiver |

---

## Tests

```bash
cd backend && npm test
```

Tests cover:
- Webhook idempotency (triple delivery, deleted task scenario)
- Optimistic locking / concurrent PATCH (Q2)
- Conflict detection logic (Q3)

---

## Known Limitations / What I'd Do With More Time

1. **Field-level auto-merge** as an optional fourth conflict resolution strategy
2. **Webhook signature verification** (HMAC-SHA256 with `GITHUB_WEBHOOK_SECRET`)
3. **Background worker process** separate from the API server for sync (currently in-process)
4. **Real-time UI updates** via WebSocket/SSE instead of polling
5. **Soft-delete propagation** — currently closing the GitHub issue on local delete; could add a "deleted" label instead
6. **Integration tests** against a test GitHub repo with mocked Octokit
7. **Metrics/observability** — Prometheus counters for sync latency, queue depth, rate limit hits
8. **Multi-repo support** — currently single repo; would add a `providers` table

---

## Live Follow-Up Answers

### Q1: Webhook delivered 3 times, user deleted task in between

**What happens:** All 3 deliveries are safely handled. The first checks `webhook_events` for the delivery ID. If the task was deleted locally (`deletedAt` is set), processing stops immediately — the task is NOT recreated. Deliveries 2 and 3 are deduplicated by `deliveryId`.

**Code:**
```typescript
// backend/src/services/webhook-handler.ts:52-58
if (localTask?.deletedAt) {
  await markWebhookProcessed(deliveryId, 'task_deleted_locally');
  return { processed: false, reason: 'task_deleted_locally' };
}
```

### Q2: Two concurrent PATCH requests

The first request with the correct `version` succeeds and increments `version`. The second request still has the old `version` — `updateMany` returns `count: 0`, and the API responds with `409 Conflict` including the current version. The client must refresh and retry.

**Code:**
```typescript
// backend/src/services/task-service.ts:64-78
const result = await tx.task.updateMany({
  where: { id, version: input.version, deletedAt: null },
  data: { ...updates, version: { increment: 1 } },
});
if (result.count === 0) {
  throw new VersionConflictError(current?.version ?? 0);
}
```

### Q3: User reports edit was lost

Under our policy, edits aren't silently lost — they're preserved in conflict fields. The trade-off is that the user must actively resolve. For field-level merge, I'd compare per-field `updatedAt` timestamps and auto-merge non-conflicting fields, only flagging fields where both sides changed.

---

## Project Structure

```
├── backend/
│   ├── prisma/schema.prisma    # Database schema
│   ├── src/
│   │   ├── services/
│   │   │   ├── github-client.ts    # GitHub API + rate limiting
│   │   │   ├── sync-engine.ts        # Core sync logic
│   │   │   ├── task-service.ts       # CRUD + optimistic locking
│   │   │   └── webhook-handler.ts    # Idempotent webhook processing
│   │   ├── routes/index.ts           # REST API routes
│   │   └── index.ts                  # Server entry point
│   └── tests/                        # Vitest tests
├── frontend/
│   └── src/
│       ├── App.tsx                   # Dashboard
│       └── components/
│           ├── TaskModal.tsx         # Create/edit
│           └── ConflictModal.tsx     # Conflict resolution UI
├── docker-compose.yml                # PostgreSQL
└── README.md
```
