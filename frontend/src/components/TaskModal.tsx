import { useState } from 'react';
import { api, Task } from '../api';
import { StatusBadge } from './Icons';

interface Props {
  task: Task | null;
  isCreate: boolean;
  onClose: () => void;
  onSave: () => void;
  onError: (msg: string) => void;
}

export function TaskModal({ task, isCreate, onClose, onSave, onError }: Props) {
  const [title, setTitle] = useState(task?.title || '');
  const [description, setDescription] = useState(task?.description || '');
  const [status, setStatus] = useState(task?.status || 'open');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setSaving(true);
    try {
      if (isCreate) {
        await api.createTask({ title, description, status });
      } else if (task) {
        await api.updateTask(task.id, { title, description, status, version: task.version });
      }
      onSave();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>{isCreate ? 'Create New Task' : 'Edit Task'}</h2>
            <p className="modal-subtitle">
              {isCreate
                ? 'Task will sync to GitHub automatically'
                : 'Changes will be pushed to GitHub on sync'}
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="task-title">Title *</label>
            <input
              id="task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Enter task title..."
              required
              autoFocus
            />
          </div>

          <div className="form-group">
            <label htmlFor="task-desc">Description</label>
            <textarea
              id="task-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add a description (optional)..."
              rows={4}
            />
          </div>

          <div className="form-group">
            <label htmlFor="task-status">Status</label>
            <select id="task-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
            </select>
          </div>

          {!isCreate && task && (
            <div className="task-modal-meta">
              <StatusBadge status={task.syncStatus} />
              {task.githubIssueNumber && (
                <span className="meta-chip">GitHub #{task.githubIssueNumber}</span>
              )}
              <span className="meta-chip">v{task.version}</span>
            </div>
          )}

          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving || !title.trim()}>
              {saving ? 'Saving...' : isCreate ? 'Create Task' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
