import { closeMaxMiniApp, getMaxBridge } from '../lib/max-bridge';
import { StatusState } from './ui/status-state';
import './public-dialog-unavailable-state.css';

type PublicDialogUnavailableStateProps = {
  title: string;
  description: string;
  tone?: 'warning' | 'danger';
};

export function PublicDialogUnavailableState({
  title,
  description,
  tone = 'warning',
}: PublicDialogUnavailableStateProps) {
  return (
    <div className="page-stack page-enter public-dialog-unavailable">
      <div className="glass-card glass-card--md">
        <StatusState
          tone={tone}
          title={title}
          description={description}
          action={
            typeof getMaxBridge()?.close === 'function' ? (
              <button
                type="button"
                className="button button--accent"
                onClick={() => closeMaxMiniApp()}
              >
                Закрыть приложение
              </button>
            ) : undefined
          }
        />
      </div>
    </div>
  );
}
