import { Task } from '../api';
import { IconTrash } from './Icons';

interface Props {
  task: Task;
  onConfirm: () => void;
  onCancel: () => void;
  deleting: boolean;
}

export function DeleteConfirmModal({ task, onConfirm, onCancel, deleting }: Props) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="delete-modal-icon">
          <IconTrash />
        </div>
        <h2>Delete Task?</h2>
        <p className="delete-modal-text">
          Are you sure you want to delete <strong>"{task.title}"</strong>?
          {task.githubIssueNumber && (
            <span className="delete-modal-hint">
              This will also close GitHub issue #{task.githubIssueNumber}.
            </span>
          )}
        </p>
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={deleting}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger-filled" onClick={onConfirm} disabled={deleting}>
            {deleting ? 'Deleting...' : 'Delete Task'}
          </button>
        </div>
      </div>
    </div>
  );
}
