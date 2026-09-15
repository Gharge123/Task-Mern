-- Safe sample data for the Task Sync Engine.
-- Run after 01_schema.sql while connected to tasksync.
SET search_path TO "tasksync_schema";

INSERT INTO "Task" (
    "id", "title", "description", "status", "syncStatus",
    "version", "localUpdatedAt", "createdAt", "updatedAt"
)
VALUES
(
    '00000000-0000-4000-8000-000000000001',
    'Test local task',
    'Sample task created from the PostgreSQL seed script.',
    'open',
    'PENDING',
    1,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
),
(
    '00000000-0000-4000-8000-000000000002',
    'GitHub sync test',
    'Use this task to test outbound synchronization with GitHub Issues.',
    'open',
    'PENDING',
    1,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;
