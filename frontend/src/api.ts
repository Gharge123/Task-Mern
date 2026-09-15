export type SyncStatus = 'SYNCED' | 'PENDING' | 'CONFLICT' | 'ERROR' | 'QUARANTINED';

export interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  syncStatus: SyncStatus;
  version: number;
  githubIssueNumber: number | null;
  localUpdatedAt: string;
  remoteUpdatedAt: string | null;
  conflictLocalTitle: string | null;
  conflictLocalDescription: string | null;
  conflictLocalStatus: string | null;
  conflictRemoteTitle: string | null;
  conflictRemoteDescription: string | null;
  conflictRemoteStatus: string | null;
  conflictDetectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskListResponse {
  tasks: Task[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface SyncStatusResponse {
  isRunning: boolean;
  queue: { pending: number; failed: number; quarantined: number };
  tasks: Record<string, number>;
  totalTasks: number;
  lastRun: {
    id: string;
    status: string;
    startedAt: string;
    completedAt: string | null;
    tasksSynced: number;
    tasksFailed: number;
  } | null;
  checkpoint: string | null;
  rateLimit: { remaining: number; resetAt: string; limit: number } | null;
}

const API_BASE = '/api';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || body.message || `HTTP ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  listTasks: (params: { search?: string; syncStatus?: string; page?: number }) => {
    const query = new URLSearchParams();
    if (params.search) query.set('search', params.search);
    if (params.syncStatus) query.set('syncStatus', params.syncStatus);
    if (params.page) query.set('page', String(params.page));
    return request<TaskListResponse>(`/tasks?${query}`);
  },

  getTask: (id: string) => request<Task>(`/tasks/${id}`),

  createTask: (data: { title: string; description?: string; status?: string }) =>
    request<Task>('/tasks', { method: 'POST', body: JSON.stringify(data) }),

  updateTask: (id: string, data: { title?: string; description?: string; status?: string; version: number }) =>
    request<Task>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  deleteTask: (id: string, version: number) =>
    request<void>(`/tasks/${id}?version=${version}`, { method: 'DELETE' }),

  resolveConflict: (
    id: string,
    resolution: 'KEEP_LOCAL' | 'KEEP_REMOTE' | 'MERGED',
    mergedData?: { title: string; description?: string; status?: string }
  ) =>
    request<Task>(`/tasks/${id}/resolve-conflict`, {
      method: 'POST',
      body: JSON.stringify({ resolution, mergedData }),
    }),

  getSyncStatus: () => request<SyncStatusResponse>('/sync/status'),

  triggerSync: () => request<{ synced: number; failed: number }>('/sync/trigger', { method: 'POST' }),
};
