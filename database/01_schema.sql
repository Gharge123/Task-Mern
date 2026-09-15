-- ================================================================
-- Task Sync Engine - PostgreSQL schema
-- Generated from backend/prisma/schema.prisma
--
-- Run this file while connected to the `tasksync` database in pgAdmin 4.
-- Safe to run on a fresh database. It creates all tables, enums,
-- indexes and the foreign-key relationship required by the application.
-- ================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS "tasksync_schema";
SET search_path TO "tasksync_schema";

-- -----------------------------
-- Enums
-- -----------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SyncStatus') THEN
        CREATE TYPE "SyncStatus" AS ENUM (
            'SYNCED', 'PENDING', 'CONFLICT', 'ERROR', 'QUARANTINED'
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SyncDirection') THEN
        CREATE TYPE "SyncDirection" AS ENUM (
            'TO_PROVIDER', 'FROM_PROVIDER'
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SyncOpStatus') THEN
        CREATE TYPE "SyncOpStatus" AS ENUM (
            'PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'QUARANTINED'
        );
    END IF;

    -- Kept because it is part of the Prisma schema and may be used by
    -- future conflict-resolution logic.
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ConflictResolution') THEN
        CREATE TYPE "ConflictResolution" AS ENUM (
            'KEEP_LOCAL', 'KEEP_REMOTE', 'MERGED'
        );
    END IF;
END
$$;

-- -----------------------------
-- Task
-- -----------------------------
CREATE TABLE IF NOT EXISTS "Task" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'open',
    "syncStatus" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),
    "githubIssueNumber" INTEGER,
    "githubUpdatedAt" TIMESTAMP(3),
    "localUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "remoteUpdatedAt" TIMESTAMP(3),
    "conflictLocalTitle" TEXT,
    "conflictLocalDescription" TEXT,
    "conflictLocalStatus" TEXT,
    "conflictRemoteTitle" TEXT,
    "conflictRemoteDescription" TEXT,
    "conflictRemoteStatus" TEXT,
    "conflictDetectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- -----------------------------
-- SyncOperation (outbox)
-- -----------------------------
CREATE TABLE IF NOT EXISTS "SyncOperation" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "direction" "SyncDirection" NOT NULL,
    "operation" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "SyncOpStatus" NOT NULL DEFAULT 'PENDING',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 5,
    "lastError" TEXT,
    "idempotencyKey" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SyncOperation_pkey" PRIMARY KEY ("id")
);

-- -----------------------------
-- WebhookEvent
-- -----------------------------
CREATE TABLE IF NOT EXISTS "WebhookEvent" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "action" TEXT,
    "payload" JSONB NOT NULL,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "processedAt" TIMESTAMP(3),
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- -----------------------------
-- SyncCheckpoint
-- -----------------------------
CREATE TABLE IF NOT EXISTS "SyncCheckpoint" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "cursor" TEXT,
    "metadata" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SyncCheckpoint_pkey" PRIMARY KEY ("id")
);

-- -----------------------------
-- SyncRun
-- -----------------------------
CREATE TABLE IF NOT EXISTS "SyncRun" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "tasksSynced" INTEGER NOT NULL DEFAULT 0,
    "tasksFailed" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "metadata" JSONB,
    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- -----------------------------
-- Unique indexes
-- -----------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "Task_githubIssueNumber_key"
    ON "Task" ("githubIssueNumber");

CREATE UNIQUE INDEX IF NOT EXISTS "SyncOperation_idempotencyKey_key"
    ON "SyncOperation" ("idempotencyKey");

CREATE UNIQUE INDEX IF NOT EXISTS "WebhookEvent_deliveryId_key"
    ON "WebhookEvent" ("deliveryId");

CREATE UNIQUE INDEX IF NOT EXISTS "SyncCheckpoint_key_key"
    ON "SyncCheckpoint" ("key");

-- -----------------------------
-- Performance indexes
-- -----------------------------
CREATE INDEX IF NOT EXISTS "Task_syncStatus_idx"
    ON "Task" ("syncStatus");

CREATE INDEX IF NOT EXISTS "Task_deletedAt_idx"
    ON "Task" ("deletedAt");

CREATE INDEX IF NOT EXISTS "Task_title_idx"
    ON "Task" ("title");

CREATE INDEX IF NOT EXISTS "Task_updatedAt_idx"
    ON "Task" ("updatedAt");

CREATE INDEX IF NOT EXISTS "SyncOperation_status_scheduledAt_idx"
    ON "SyncOperation" ("status", "scheduledAt");

CREATE INDEX IF NOT EXISTS "SyncOperation_taskId_idx"
    ON "SyncOperation" ("taskId");

CREATE INDEX IF NOT EXISTS "WebhookEvent_processed_idx"
    ON "WebhookEvent" ("processed");

-- -----------------------------
-- Foreign key
-- -----------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'SyncOperation_taskId_fkey'
    ) THEN
        ALTER TABLE "SyncOperation"
            ADD CONSTRAINT "SyncOperation_taskId_fkey"
            FOREIGN KEY ("taskId")
            REFERENCES "Task" ("id")
            ON DELETE CASCADE
            ON UPDATE CASCADE;
    END IF;
END
$$;

COMMIT;

-- Verification queries (optional; safe to run separately)
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public' ORDER BY table_name;
-- SELECT COUNT(*) AS task_count FROM "Task";
