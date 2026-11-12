import './refresh-notice.css';

type RefreshNoticeProps = {
  children: string;
  pending: boolean;
  onRetry: () => void;
};

export function RefreshNotice({ children, pending, onRetry }: RefreshNoticeProps) {
  return (
    <div className="refresh-notice" role="status">
      <span>{children}</span>
      <button type="button" onClick={onRetry} disabled={pending}>
        {pending ? 'Обновляю…' : 'Повторить'}
      </button>
    </div>
  );
}
