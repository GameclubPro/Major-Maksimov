import { useEffect, useRef, useState } from 'react';
import { canShareNativeContent, shareNativeContent } from '../../../lib/max-bridge';
import './share-link.css';

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
  const [notice, setNotice] = useState<{ url: string; text: string } | null>(null);
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const current = useRef(0);
  const latest = useRef({ url, disabled });
  latest.current = { url, disabled };
  useEffect(() => {
    current.current++;
    setBusy(false);
    setNotice(null);
    setManualUrl(null);
    return () => {
      current.current++;
    };
  }, [url, disabled]);
  const share = async () => {
    if (!url || disabled || busy) return;
    const epoch = ++current.current;
    const active = () =>
      epoch === current.current && latest.current.url === url && !latest.current.disabled;
    setBusy(true);
    setNotice(null);
    setManualUrl(null);
    try {
      if (canShareNativeContent()) {
        try {
          await shareNativeContent({ link: url, preferMax: true });
          return;
        } catch {
          /* Native sharing may be unavailable in the current MAX window. */
        }
      }
      if (!active()) return;
      await navigator.clipboard.writeText(url);
      if (active()) setNotice({ url, text: 'Ссылка скопирована' });
    } catch {
      if (active()) {
        setNotice({ url, text: 'Скопируйте ссылку вручную.' });
        setManualUrl(url);
      }
    } finally {
      if (active()) setBusy(false);
    }
  };
  return (
    <div className="karavan-shop__share">
      <button type="button" disabled={disabled || !url || busy} onClick={() => void share()}>
        {busy ? 'Открываем…' : label}
      </button>
      {notice && !disabled && notice.url === url ? <p role="status">{notice.text}</p> : null}
      {!disabled && url && manualUrl === url ? (
        <label className="karavan-shop__manual-link">
          <span>Ссылка для копирования</span>
          <textarea
            readOnly
            rows={3}
            value={url}
            onFocus={(event) => event.currentTarget.select()}
            onClick={(event) => event.currentTarget.select()}
          />
        </label>
      ) : null}
    </div>
  );
}
