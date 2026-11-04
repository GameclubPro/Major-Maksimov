import { useEffect, useRef, useState } from 'react';
import { canShareNativeContent, shareNativeContent } from '../../../lib/max-bridge';

export function ShopShareLink({
  url,
  disabled = false,
  label = 'Поделиться ссылкой',
}: {
  url: string | null | undefined;
  disabled?: boolean;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const current = useRef(0);
  useEffect(() => {
    current.current++;
    setBusy(false);
    setNotice(null);
    return () => {
      current.current++;
    };
  }, [url]);
  const share = async () => {
    if (!url || disabled || busy) return;
    const epoch = ++current.current;
    setBusy(true);
    setNotice(null);
    try {
      if (canShareNativeContent()) {
        try {
          await shareNativeContent({ link: url, preferMax: true });
          return;
        } catch {
          /* Native sharing may be unavailable in the current MAX window. */
        }
      }
      if (epoch !== current.current) return;
      await navigator.clipboard.writeText(url);
      if (epoch === current.current) setNotice('Ссылка скопирована');
    } catch {
      if (epoch === current.current) setNotice('Не удалось скопировать ссылку. Повторите.');
    } finally {
      if (epoch === current.current) setBusy(false);
    }
  };
  return (
    <div className="karavan-shop__share">
      <button type="button" disabled={disabled || !url || busy} onClick={() => void share()}>
        {busy ? 'Открываем…' : label}
      </button>
      {notice ? <p role="status">{notice}</p> : null}
    </div>
  );
}
