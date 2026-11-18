import { StorefrontAudience } from './storefront-audience';
import { AppIcon as IconoirSprite } from '../../components/ui/app-icon';
import { getNetworkSettingsSectionPresentation } from './settings-workspace-sections';

import { useMutation, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useRef, useState, type ReactNode } from 'react';
import type { ChatSettings } from '@maxim/contracts/settings';
import type {
  KaravanStorefrontAllowlistEntry,
  KaravanStorefrontTextField,
  KaravanStorefrontTexts,
} from '@maxim/contracts/karavan-storefront';
import { SettingsStorefrontTextEditor } from './settings-storefront-text-editor';
import { GlassCard } from '../../components/ui/glass-card';
import { StorefrontWorkspace } from './storefront-workspace';
import { SettingsSectionToggle } from '../../components/ui/settings-section-toggle';
import { Spinner } from '../../components/ui/spinner';
import { useToast } from '../../components/ui/toast';
import type { ApiTransport } from '../../lib/api/transport';
import {
  getKaravanStorefrontAllowlist,
  handoffKaravanStorefrontAllowlist,
  revokeKaravanStorefrontAllowlistEntry,
} from '../../lib/api/chat-settings-client';
import { cn } from '../../lib/cn';
import { maxNotify, openMaxBotLinkAndClose } from '../../lib/max-bridge';
import { describeUserFacingError } from '../../lib/user-facing-error';
import '../../styles/settings-storefront.css';

const ConfirmRevoke = lazy(() =>
  import('../../components/ui/action-confirm-sheet').then((module) => ({
    default: module.ActionConfirmSheet,
  })),
);
const KaravanMarketplacePanel = lazy(() => import('./karavan-marketplace-panel'));

type SettingsStorefrontSectionProps = {
  sharedContent?: ReactNode;
  draft: Pick<ChatSettings, 'karavanStorefrontEnabled' | 'karavanStorefrontAdminsOnly'> &
    KaravanStorefrontTexts;
  api: ApiTransport;
  chatId?: string | null;
  expanded: boolean;
  summary: string;
  status: string;
  headerAction?: ReactNode;
  footer: ReactNode;
  hasChanges: boolean;
  onDiscardChanges: () => void;
  onToggleSection: () => void;
  onFieldChange: (value: boolean) => void;
  onAdminsOnlyChange: (value: boolean) => void;
  onTextChange: (field: KaravanStorefrontTextField, value: string) => void;
};

function formatAllowlistExpiry(expiresAt: string | null): string {
  if (!expiresAt) {
    return 'Бессрочно';
  }

  const parsed = new Date(expiresAt);
  if (Number.isNaN(parsed.getTime())) {
    return 'Срок не указан';
  }

  return `до ${new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(parsed)}`;
}

function allowlistEntryLabel(entry: KaravanStorefrontAllowlistEntry): string {
  return entry.displayName?.trim() || `Пользователь ${entry.userId}`;
}

const SECTION_PRESENTATION = getNetworkSettingsSectionPresentation('chat', 'storefront');

export function SettingsStorefrontSection({
  sharedContent,
  draft,
  api,
  chatId,
  expanded,
  summary,
  status,
  headerAction,
  footer,
  hasChanges,
  onDiscardChanges,
  onToggleSection,
  onFieldChange,
  onAdminsOnlyChange,
  onTextChange,
}: SettingsStorefrontSectionProps) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [entryToRevoke, setEntryToRevoke] = useState<KaravanStorefrontAllowlistEntry | null>(null);
  const allowlistQueryKey = ['karavan-storefront-allowlist', chatId] as const;
  const allowlistVisible =
    expanded && draft.karavanStorefrontEnabled && draft.karavanStorefrontAdminsOnly;
  const allowlistQuery = useInfiniteQuery({
    queryKey: allowlistQueryKey,
    queryFn: ({ signal, pageParam }) =>
      getKaravanStorefrontAllowlist(api, chatId ?? '', {
        signal,
        limit: 100,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(chatId) && allowlistVisible,
    staleTime: 0,
    refetchOnWindowFocus: 'always',
  });
  const openingBot = useRef(false);
  const handoffMutation = useMutation({
    mutationFn: async () => {
      const { botUrl } = await handoffKaravanStorefrontAllowlist(api, chatId ?? '');
      try {
        if (openMaxBotLinkAndClose(botUrl)) return;
      } catch {
        // MAX can refuse the transition after the server has prepared the conversation.
      }
      throw new Error('Не удалось открыть личный чат бота. Попробуйте ещё раз.');
    },
    onError: () => maxNotify('error'),
    onSettled: () => {
      openingBot.current = false;
    },
  });
  const revokeMutation = useMutation({
    mutationFn: (entryId: string) =>
      revokeKaravanStorefrontAllowlistEntry(api, chatId ?? '', entryId),
    onSuccess: () => {
      setEntryToRevoke(null);
      void queryClient.invalidateQueries({ queryKey: allowlistQueryKey });
      pushToast({ tone: 'success', title: 'Доступ отозван' });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось отозвать доступ',
        description: describeUserFacingError(error, 'Повторите попытку.'),
      });
      maxNotify('error');
    },
  });

  const entries = [
    ...new Map(
      (allowlistQuery.data?.pages.flatMap((page) => page.items) ?? []).map((entry) => [
        entry.id,
        entry,
      ]),
    ).values(),
  ];

  const publicationControls = (
    <div className="settings-storefront__publications">
      {headerAction ? (
        <div className="storefront-workspace__copy-settings">{headerAction}</div>
      ) : null}
      {sharedContent ?? (
        <div className="settings-native-toggle">
          <div className="settings-native-toggle__row">
            <div className="settings-native-toggle__title-wrap">
              <span className="settings-native-toggle__title">Ответ бота на $</span>
            </div>

            <label className="settings-native-switch" aria-label="Ответ бота на $">
              <input
                type="checkbox"
                checked={draft.karavanStorefrontEnabled}
                onChange={(event) => onFieldChange(event.target.checked)}
              />
              <span className="toggle-switch" aria-hidden>
                <span className="toggle-switch__thumb" />
              </span>
            </label>
          </div>
        </div>
      )}

      {draft.karavanStorefrontEnabled ? (
        <>
          {!sharedContent ? (
            <StorefrontAudience
              state={{ kind: 'common', value: draft.karavanStorefrontAdminsOnly }}
              onChange={onAdminsOnlyChange}
            />
          ) : null}
          {!sharedContent ? (
            <SettingsStorefrontTextEditor draft={draft} onChange={onTextChange} />
          ) : null}

          {draft.karavanStorefrontAdminsOnly ? (
            <section
              className="settings-storefront__allowlist"
              aria-labelledby="settings-storefront-allowlist-title"
            >
              <div className="settings-storefront__allowlist-head">
                <div>
                  <h3 id="settings-storefront-allowlist-title">Доступ к ответу на $ в этом чате</h3>
                  <p>
                    {hasChanges
                      ? 'Сохраните настройки перед переходом к боту.'
                      : 'В личном чате с ботом перешлите сообщение участника и выберите срок доступа.'}
                  </p>
                </div>
                <button
                  type="button"
                  className="settings-storefront__add-button"
                  onClick={() => {
                    if (openingBot.current || !chatId || hasChanges) return;
                    openingBot.current = true;
                    handoffMutation.mutate();
                  }}
                  disabled={!chatId || hasChanges || handoffMutation.isPending}
                >
                  <IconoirSprite variant="iconoir" icon="PlusCircle" aria-hidden />
                  <span>
                    {handoffMutation.isPending
                      ? 'Открываем бота…'
                      : handoffMutation.isError
                        ? 'Повторить переход к боту'
                        : 'Выдать доступ через бота'}
                  </span>
                </button>
              </div>
              {handoffMutation.isError && !hasChanges ? (
                <p role="alert" className="settings-storefront__state">
                  {describeUserFacingError(
                    handoffMutation.error,
                    'Не удалось открыть личный чат бота. Попробуйте ещё раз.',
                  )}
                </p>
              ) : null}

              {allowlistQuery.isLoading ? (
                <div className="settings-storefront__state" role="status">
                  <Spinner size="sm" label="Загружаем список" />
                  <span>Загружаем список...</span>
                </div>
              ) : allowlistQuery.isError && !allowlistQuery.data ? (
                <div className="settings-storefront__state settings-storefront__state--error">
                  <p>
                    {describeUserFacingError(allowlistQuery.error, 'Не удалось загрузить список.')}
                  </p>
                  <button type="button" onClick={() => void allowlistQuery.refetch()}>
                    Повторить
                  </button>
                </div>
              ) : entries.length === 0 ? (
                <p className="settings-storefront__empty">Персональных разрешений пока нет.</p>
              ) : (
                <div className="settings-storefront__list" aria-live="polite">
                  {entries.map((entry) => (
                    <div className="settings-storefront__entry" key={entry.id}>
                      <div className="settings-storefront__entry-copy">
                        <strong>{allowlistEntryLabel(entry)}</strong>
                        <span>{formatAllowlistExpiry(entry.expiresAt)}</span>
                      </div>
                      <button
                        type="button"
                        className="settings-storefront__revoke-button"
                        aria-label={`Отозвать доступ: ${allowlistEntryLabel(entry)}`}
                        title="Отозвать доступ"
                        onClick={() => setEntryToRevoke(entry)}
                        disabled={revokeMutation.isPending}
                      >
                        <IconoirSprite variant="iconoir" icon="Trash" aria-hidden />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {allowlistQuery.hasNextPage ? (
                <button
                  type="button"
                  className="settings-storefront__more"
                  disabled={allowlistQuery.isFetchingNextPage}
                  onClick={() => void allowlistQuery.fetchNextPage()}
                >
                  {allowlistQuery.isFetchingNextPage ? 'Загружаем…' : 'Ещё пользователи'}
                </button>
              ) : null}
              {allowlistQuery.isFetchNextPageError ? (
                <p role="alert">Не удалось загрузить следующую страницу. Повторите загрузку.</p>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );

  return (
    <>
      {entryToRevoke ? (
        <Suspense fallback={null}>
          <ConfirmRevoke
            open
            id="storefront-revoke"
            className="storefront-revoke-confirm"
            title="Отозвать доступ к ответу на $?"
            previewTitle={allowlistEntryLabel(entryToRevoke)}
            confirmLabel="Отозвать доступ"
            confirmBusyLabel="Отзываем…"
            isBusy={revokeMutation.isPending}
            onClose={() => setEntryToRevoke(null)}
            onConfirm={() => revokeMutation.mutate(entryToRevoke.id)}
          />
        </Suspense>
      ) : null}
      <GlassCard
        className="settings-section settings-home-entry settings-home-entry--priority stagger-in"
        style={{ animationDelay: '386ms', order: SECTION_PRESENTATION.order }}
        aria-label="Магазин чата"
      >
        <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
          <SettingsSectionToggle
            title={SECTION_PRESENTATION.title}
            enabled={draft.karavanStorefrontEnabled}
            summary={summary}
            status={status}
            icon={SECTION_PRESENTATION.icon}
            tone={SECTION_PRESENTATION.tone}
            open={expanded}
            controls="settings-storefront-content"
            onClick={onToggleSection}
          />
        </div>

        <StorefrontWorkspace
          open={expanded}
          onClose={onToggleSection}
          dirty={hasChanges}
          onDiscard={onDiscardChanges}
          footer={footer}
        >
          <div
            id="settings-storefront-collapse"
            className={cn('settings-section__collapse', expanded && 'is-open')}
          >
            {expanded ? (
              <div className="settings-section__collapse-inner">
                {chatId ? (
                  <Suspense fallback={<Spinner size="sm" label="Проверяем магазин" />}>
                    <KaravanMarketplacePanel
                      key={chatId}
                      api={api}
                      chatId={chatId}
                      publications={publicationControls}
                    />
                  </Suspense>
                ) : (
                  publicationControls
                )}
              </div>
            ) : null}
          </div>
        </StorefrontWorkspace>
      </GlassCard>
    </>
  );
}
