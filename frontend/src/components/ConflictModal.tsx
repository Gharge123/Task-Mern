import { useState } from 'react';
import { api, Task } from '../api';

interface Props {
  task: Task;
  onClose: () => void;
  onResolved: () => void;
  onError: (msg: string) => void;
}

export function ConflictModal({ task, onClose, onResolved, onError }: Props) {
  const [mergeTitle, setMergeTitle] = useState(task.conflictLocalTitle || task.title);
  const [mergeDescription, setMergeDescription] = useState(
    task.conflictLocalDescription || task.description
  );
  const [mergeStatus, setMergeStatus] = useState(task.conflictLocalStatus || task.status);
  const [resolving, setResolving] = useState(false);

  const handleResolve = async (resolution: 'KEEP_LOCAL' | 'KEEP_REMOTE' | 'MERGED') => {
    setResolving(true);
    try {
      if (resolution === 'MERGED') {
        await api.resolveConflict(task.id, 'MERGED', {
          title: mergeTitle,
          description: mergeDescription,
          status: mergeStatus,
        });
      } else {
        await api.resolveConflict(task.id, resolution);
      }
      onResolved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Resolution failed');
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720 }}>
        <h2>Resolve Conflict</h2>
        <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', marginBottom: '1.25rem' }}>
          This task was modified both locally and on GitHub. Choose which version to keep, or merge manually.
        </p>

        <div className="conflict-panel">
          <div className="conflict-side local">
            <h3>Local Version</h3>
            <div className="conflict-field">
              <strong>Title</strong>
              <div>{task.conflictLocalTitle}</div>
            </div>
            <div className="conflict-field">
              <strong>Description</strong>
              <div>{task.conflictLocalDescription || '(empty)'}</div>
            </div>
            <div className="conflict-field">
              <strong>Status</strong>
              <div>{task.conflictLocalStatus}</div>
            </div>
          </div>

          <div className="conflict-side remote">
            <h3>Remote (GitHub)</h3>
            <div className="conflict-field">
              <strong>Title</strong>
              <div>{task.conflictRemoteTitle}</div>
            </div>
            <div className="conflict-field">
              <strong>Description</strong>
              <div>{task.conflictRemoteDescription || '(empty)'}</div>
            </div>
            <div className="conflict-field">
              <strong>Status</strong>
              <div>{task.conflictRemoteStatus}</div>
            </div>
          </div>
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <h3 style={{ fontSize: '0.875rem', marginBottom: '0.75rem' }}>Manual Merge</h3>
          <div className="form-group">
            <label>Title</label>
            <input value={mergeTitle} onChange={(e) => setMergeTitle(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Description</label>
            <textarea value={mergeDescription} onChange={(e) => setMergeDescription(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Status</label>
            <select value={mergeStatus} onChange={(e) => setMergeStatus(e.target.value)}>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
            </select>
          </div>
        </div>

        <div className="conflict-actions">
          <button className="btn btn-primary btn-sm" disabled={resolving} onClick={() => handleResolve('KEEP_LOCAL')}>
            Keep Local
          </button>
          <button className="btn btn-secondary btn-sm" disabled={resolving} onClick={() => handleResolve('KEEP_REMOTE')}>
            Keep Remote
          </button>
          <button className="btn btn-primary btn-sm" disabled={resolving} onClick={() => handleResolve('MERGED')}>
            Use Merged Version
          </button>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
