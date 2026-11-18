import { useRef, useState } from 'react';
import { AppIcon } from '../ui/app-icon';

export function ParticipantMaxId({ userId }: { userId: string }) {
  const field = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<'copied' | 'manual' | null>(null);
  if (!/^\d{1,24}$/u.test(userId)) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(userId);
      setStatus('copied');
    } catch {
      field.current?.focus({ preventScroll: true });
      field.current?.select();
      setStatus('manual');
    }
  };
  return (
    <div className="participant-card__max-id">
      <label>
        ID MAX
        <input
          ref={field}
          value={userId}
          style={{ width: `${userId.length + 0.5}ch` }}
          readOnly
          inputMode="none"
          onFocus={(event) => event.currentTarget.select()}
        />
      </label>
      <button
        type="button"
        aria-label="Скопировать ID MAX"
        title="Скопировать ID MAX"
        onClick={() => void copy()}
      >
        <AppIcon icon={status === 'copied' ? 'Check' : 'Copy'} aria-hidden />
      </button>
      <span role="status">
        {status === 'manual'
          ? 'Скопируйте выделенные цифры вручную.'
          : status === 'copied'
            ? 'ID скопирован'
            : ''}
      </span>
    </div>
  );
}
