import { useEffect, useRef, useState } from 'react';
import { commercialAdsUserIdSchema } from '@maxim/contracts/settings';
import type { ChatParticipantItem } from '@maxim/contracts';
import { getChatParticipantsPage } from '../../lib/api/events-client';
import type { CommercialAuthor } from '../../lib/commercial-ads-policy';
import { describeUserFacingError } from '../../lib/user-facing-error';
import { AppIcon } from '../../components/ui/app-icon';
import { PersonAvatar } from '../../components/ui/person-avatar';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { Spinner } from '../../components/ui/spinner';
import type { CommercialSettingsScope } from './commercial-policy-model';
import './commercial-policy-sheets.css';

export function CommercialAuthorPicker({
  scope,
  onSelect,
  onClose,
}: {
  scope: CommercialSettingsScope;
  onSelect: (author: CommercialAuthor) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<ChatParticipantItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeLoad = useRef<AbortController | null>(null);
  useEffect(() => {
    const request = ++generation.current;
    const controller = new AbortController();
    activeLoad.current?.abort();
    activeLoad.current = controller;
    setItems([]);
    setCursor(null);
    setBusy(true);
    setError(null);
    const timeout = window.setTimeout(
      () => {
        void getChatParticipantsPage(
          scope.api,
          scope.chatId,
          { search, limit: 30, range: '30d', roleFilter: 'all' },
          { signal: controller.signal },
        )
          .then((result) => {
            if (request === generation.current && !controller.signal.aborted) {
              setItems(
                result.items.filter(
                  (item) => !item.isBot && commercialAdsUserIdSchema.safeParse(item.userId).success,
                ),
              );
              setCursor(result.nextCursor);
            }
          })
          .catch((cause) => {
            if (!controller.signal.aborted && request === generation.current)
              setError(describeUserFacingError(cause, 'Не удалось загрузить участников.'));
          })
          .finally(() => {
            if (!controller.signal.aborted && request === generation.current) setBusy(false);
          });
      },
      search ? 200 : 0,
    );
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [scope.api, scope.chatId, search, retry]);
  const loadMore = async () => {
    if (!cursor || busy) return;
    const request = generation.current;
    const controller = new AbortController();
    activeLoad.current = controller;
    setBusy(true);
    setError(null);
    try {
      const result = await getChatParticipantsPage(
        scope.api,
        scope.chatId,
        { search, cursor, limit: 30, range: '30d', roleFilter: 'all' },
        { signal: controller.signal },
      );
      if (request !== generation.current || controller.signal.aborted) return;
      setItems((previous) => [
        ...previous,
        ...result.items.filter(
          (item) =>
            !item.isBot &&
            commercialAdsUserIdSchema.safeParse(item.userId).success &&
            !previous.some((entry) => entry.userId === item.userId),
        ),
      ]);
      setCursor(result.nextCursor);
    } catch (cause) {
      if (!controller.signal.aborted && request === generation.current)
        setError(describeUserFacingError(cause, 'Не удалось загрузить участников.'));
    } finally {
      if (!controller.signal.aborted && request === generation.current) setBusy(false);
    }
  };
  useEffect(() => () => activeLoad.current?.abort(), []);
  return (
    <SettingsDrilldownPanel
      id="commercial-author-picker"
      open
      title="Выбрать участника"
      className="commercial-panel"
      onClose={onClose}
      initialFocusRef={inputRef}
    >
      <div className="commercial-policy commercial-policy--sheet">
        <label className="commercial-policy__search">
          <AppIcon icon="Search" />
          <input
            ref={inputRef}
            type="search"
            value={search}
            maxLength={100}
            aria-label="Поиск участника"
            placeholder="Поиск по имени"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        {error ? (
          <div className="commercial-policy__error" role="alert">
            <p>{error}</p>
            <button
              type="button"
              className="button button--ghost"
              disabled={busy}
              onClick={() => setRetry((value) => value + 1)}
            >
              Повторить
            </button>
          </div>
        ) : null}
        <ul className="commercial-policy__participants" aria-label="Участники" aria-busy={busy}>
          {items.map((item) => (
            <li key={item.userId}>
              <button
                type="button"
                onClick={() => {
                  onSelect({
                    userId: item.userId,
                    userName: item.userDisplayName?.trim().slice(0, 128) || 'Участник',
                    avatarUrl: item.avatarUrl,
                  });
                }}
              >
                <PersonAvatar
                  avatarUrl={item.avatarUrl}
                  fallback={(item.userDisplayName || 'У').slice(0, 1)}
                  className="commercial-policy__avatar"
                />
                <span>{item.userDisplayName || 'Участник'}</span>
                <AppIcon icon="NavArrowRight" />
              </button>
            </li>
          ))}
        </ul>
        {busy ? (
          <Spinner label="Загружаем участников" />
        ) : !items.length && !error ? (
          <p className="commercial-policy__notice" role="status">
            Участники не найдены
          </p>
        ) : null}
        {cursor && !busy ? (
          <button type="button" className="button button--ghost" onClick={() => void loadMore()}>
            Показать ещё
          </button>
        ) : null}
      </div>
    </SettingsDrilldownPanel>
  );
}
