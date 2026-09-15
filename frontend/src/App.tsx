import { useState, useEffect, useCallback, useRef } from 'react';
import { api, Task, SyncStatusResponse } from './api';
import { TaskModal } from './components/TaskModal';
import { ConflictModal } from './components/ConflictModal';
import { DeleteConfirmModal } from './components/DeleteConfirmModal';
import { StatusBadge, IconPlus, IconEdit, IconTrash, IconSync, IconSearch, IconGitHub } from './components/Icons';

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0 });
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const isFirstLoad = useRef(true);
  const [error, setError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatusResponse | null>(null);
  const [syncing, setSyncing] = useState(false);

  const [modalTask, setModalTask] = useState<Task | null>(null);
  const [isCreateMode, setIsCreateMode] = useState(false);
  const [conflictTask, setConflictTask] = useState<Task | null>(null);
  const [deleteTask, setDeleteTask] = useState<Task | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchTasks = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const result = await api.listTasks({
        search: debouncedSearch || undefined,
        syncStatus: statusFilter || undefined,
        page: pagination.page,
      });
      setTasks(result.tasks);
      setPagination(result.pagination);
    } catch (err) {
      if (!silent) {
        setError(err instanceof Error ? err.message : 'Failed to load tasks');
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [debouncedSearch, statusFilter, pagination.page]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchInput), 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const fetchSyncStatus = useCallback(async () => {
    try {
      const status = await api.getSyncStatus();
      setSyncStatus(status);
    } catch {
      // non-critical
    }
  }, []);

  useEffect(() => {
    const silent = !isFirstLoad.current;
    fetchTasks(silent);
    fetchSyncStatus();
    isFirstLoad.current = false;
  }, [debouncedSearch, statusFilter, pagination.page, fetchTasks, fetchSyncStatus]);

  useEffect(() => {
    const interval = setInterval(() => {
      fetchTasks(true);
      fetchSyncStatus();
    }, 3000);
    return () => clearInterval(interval);
  }, [fetchTasks, fetchSyncStatus]);

  const handleTriggerSync = async () => {
    setSyncing(true);
    setError(null);
    try {
      await api.triggerSync();
      await fetchTasks(true);
      await fetchSyncStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTask) return;
    setDeleting(true);
    try {
      await api.deleteTask(deleteTask.id, deleteTask.version);
      setDeleteTask(null);
      await fetchTasks(true);
      await fetchSyncStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  };

  const openCreate = () => {
    setModalTask(null);
    setIsCreateMode(true);
  };

  const openEdit = (task: Task) => {
    if (task.syncStatus === 'CONFLICT') {
      setConflictTask(task);
      return;
    }
    setModalTask(task);
    setIsCreateMode(false);
  };

  const handleModalSave = async () => {
    setModalTask(null);
    setIsCreateMode(false);
    await fetchTasks(true);
    await fetchSyncStatus();
  };

  const handleConflictResolved = async () => {
    setConflictTask(null);
    await fetchTasks(true);
    await fetchSyncStatus();
  };

  const stats = syncStatus?.tasks || {};

  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <div className="app-header-left">
          <div className="app-logo">
            <IconGitHub />
          </div>
          <div>
            <h1>Task Sync Dashboard</h1>
            <p className="subtitle">Manage tasks synced with GitHub Issues</p>
          </div>
        </div>
        <div className="app-header-actions">
          <button
            className="btn btn-secondary"
            onClick={handleTriggerSync}
            disabled={syncing || syncStatus?.isRunning}
          >
            {syncing ? <><span className="spinner" /> Syncing...</> : <><IconSync /> Sync Now</>}
          </button>
          <button className="btn btn-primary" onClick={openCreate}>
            <IconPlus /> Create Task
          </button>
        </div>
      </header>

      {/* Stats */}
      {syncStatus && (
        <div className="stats-grid">
          <div className="stat-card">
            <span className="stat-label">Total Tasks</span>
            <span className="stat-value">
              {syncStatus.totalTasks ??
                Object.values(stats).reduce((sum, n) => sum + n, 0)}
            </span>
          </div>
          <div className="stat-card stat-synced">
            <span className="stat-label">Synced</span>
            <span className="stat-value">{stats.SYNCED || 0}</span>
          </div>
          <div className="stat-card stat-pending">
            <span className="stat-label">Pending</span>
            <span className="stat-value">{stats.PENDING || 0}</span>
          </div>
          <div className="stat-card stat-conflict">
            <span className="stat-label">Conflicts</span>
            <span className="stat-value">{stats.CONFLICT || 0}</span>
          </div>
          {syncStatus.rateLimit && (
            <div className="stat-card stat-api">
              <span className="stat-label">API Remaining</span>
              <span className="stat-value stat-value-api">
                <span className="api-remaining">{syncStatus.rateLimit.remaining}</span>
                <span className="api-separator">/</span>
                <span className="api-limit">{syncStatus.rateLimit.limit}</span>
              </span>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button className="btn btn-sm btn-secondary" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {/* Toolbar */}
      <div className="toolbar">
        <div className="search-wrapper">
          <IconSearch />
          <input
            className="search-input"
            placeholder="Search by title or description..."
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              setPagination((p) => ({ ...p, page: 1 }));
            }}
          />
        </div>
        <select
          className="filter-select"
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPagination((p) => ({ ...p, page: 1 }));
          }}
        >
          <option value="">All Statuses</option>
          <option value="SYNCED">Synced</option>
          <option value="PENDING">Pending</option>
          <option value="CONFLICT">Conflict</option>
          <option value="ERROR">Error</option>
          <option value="QUARANTINED">Quarantined</option>
        </select>
      </div>

      {/* Task Table */}
      <div className="table-container">
        {loading ? (
          <div className="loading-state"><span className="spinner" /> Loading tasks...</div>
        ) : tasks.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📋</div>
            <h3>{searchInput || statusFilter ? 'No tasks found' : 'No tasks yet'}</h3>
            <p>{searchInput || statusFilter ? 'Try changing your search or filter.' : 'Create your first task to get started.'}</p>
            {!searchInput && !statusFilter && (
              <button className="btn btn-primary" onClick={openCreate}>
                <IconPlus /> Create Task
              </button>
            )}
          </div>
        ) : (
          <table className="task-table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Status</th>
                <th>Sync</th>
                <th>GitHub</th>
                <th>Updated</th>
                <th className="th-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.id} className={task.syncStatus === 'CONFLICT' ? 'row-conflict' : ''}>
                  <td>
                    <div className="cell-title">{task.title}</div>
                    {task.description && (
                      <div className="cell-desc">{task.description}</div>
                    )}
                  </td>
                  <td>
                    <span className={`status-pill status-${task.status}`}>
                      {task.status}
                    </span>
                  </td>
                  <td>
                    <StatusBadge status={task.syncStatus} />
                  </td>
                  <td>
                    {task.githubIssueNumber ? (
                      <span className="github-link">#{task.githubIssueNumber}</span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="cell-date">{formatDate(task.updatedAt)}</td>
                  <td>
                    <div className="row-actions">
                      {task.syncStatus === 'CONFLICT' ? (
                        <button
                          className="btn btn-warning btn-icon"
                          onClick={() => setConflictTask(task)}
                          title="Resolve conflict"
                        >
                          Resolve
                        </button>
                      ) : (
                        <button
                          className="btn btn-ghost btn-icon"
                          onClick={() => openEdit(task)}
                          title="Edit task"
                        >
                          <IconEdit /> Edit
                        </button>
                      )}
                      <button
                        className="btn btn-ghost-danger btn-icon"
                        onClick={() => setDeleteTask(task)}
                        title="Delete task"
                      >
                        <IconTrash /> Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {pagination.totalPages > 1 && (
        <div className="pagination">
          <button
            className="btn btn-secondary btn-sm"
            disabled={pagination.page <= 1}
            onClick={() => setPagination((p) => ({ ...p, page: p.page - 1 }))}
          >
            ← Previous
          </button>
          <span className="pagination-info">
            Page {pagination.page} of {pagination.totalPages} · {pagination.total} tasks
          </span>
          <button
            className="btn btn-secondary btn-sm"
            disabled={pagination.page >= pagination.totalPages}
            onClick={() => setPagination((p) => ({ ...p, page: p.page + 1 }))}
          >
            Next →
          </button>
        </div>
      )}

      {(modalTask || isCreateMode) && (
        <TaskModal
          task={modalTask}
          isCreate={isCreateMode}
          onClose={() => { setModalTask(null); setIsCreateMode(false); }}
          onSave={handleModalSave}
          onError={setError}
        />
      )}

      {conflictTask && (
        <ConflictModal
          task={conflictTask}
          onClose={() => setConflictTask(null)}
          onResolved={handleConflictResolved}
          onError={setError}
        />
      )}

      {deleteTask && (
        <DeleteConfirmModal
          task={deleteTask}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTask(null)}
          deleting={deleting}
        />
      )}
    </div>
  );
}
