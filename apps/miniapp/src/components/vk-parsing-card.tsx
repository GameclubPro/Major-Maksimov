import { VkPublicationOptions } from './vk-parsing/publication-options';
import { buildVkParsingSourceLink } from '@maxim/contracts/vk-parsing';
import { AppIcon as IconoirSprite } from './ui/app-icon';
import {
  CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
  type ChannelPostSignatureSettings,
} from '@maxim/contracts/channel-post-signature';
import { lazy, Suspense, useEffect, useId, useState } from 'react';

import type { ApiTransport } from '../lib/api/transport';
import type { VkParsingEntityType } from '../lib/api/vk-parsing-client';
import { ActionConfirmSheet } from './ui/action-confirm-sheet';
import { SettingsDrilldownPanel } from './ui/settings-drilldown-panel';
import { SkeletonCard } from './ui/skeleton';
import { StatusState } from './ui/status-state';
import { buildAutopostStatus } from './vk-parsing/autopost-status';
import { BotReviewPanel, useVkBotReviewState } from './vk-parsing/bot-review-panel';
import { normalizeApiError } from './vk-parsing/format';
import { VkInfoButton } from './vk-parsing/info-button';
import { resolveVkParsingFallbackLink } from './vk-parsing/link-selection';
import { Pagination } from './vk-parsing/pagination';
import { PostList } from './vk-parsing/post-list';
import { SchedulerPanel } from './vk-parsing/scheduler-panel';
import { SourceDashboard } from './vk-parsing/source-dashboard';
import { StatusFilterBar } from './vk-parsing/status-filter-bar';
import { useVkParsingCard } from './vk-parsing/use-vk-parsing-card';
import '../styles/vk-parsing.css';
import '../styles/vk-parsing-workspace.css';

const LazyQueueTimeline = lazy(() =>
  import('./vk-parsing/queue-timeline').then((module) => ({ default: module.QueueTimeline })),
);
const LazyPostEditor = lazy(() =>
  import('./vk-parsing/post-editor').then((module) => ({ default: module.PostEditor })),
);
type WorkspaceView = 'posts' | 'sources' | 'automation';

type VkParsingCardProps = {
  api: ApiTransport;
  chatId: string;
  active: boolean;
  entityType?: VkParsingEntityType;
  channelLinkUrl?: string;
  postSignature?: ChannelPostSignatureSettings;
};

export function VkParsingCard({
  api,
  chatId,
  active,
  entityType = 'channel',
  channelLinkUrl,
  postSignature,
}: VkParsingCardProps) {
  const state = useVkParsingCard({ api, chatId, active, entityType });
  const botReview = useVkBotReviewState(api, chatId, active && entityType === 'channel');
  const { feed, feedQuery, sources, settings, posts, editingPost } = state;
  const [view, setView] = useState<WorkspaceView>('posts');
  const [discardEditor, setDiscardEditor] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const tabsId = useId();
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, [active]);
  const status = buildAutopostStatus(settings, sources, now);
  const queueCount = sources.reduce((sum, source) => sum + source.queuedPostCount, 0);
  const isSyncing = sources.some(
    (source) => source.syncStatus === 'QUEUED' || source.syncStatus === 'SYNCING',
  );
  const activeSources = sources.filter((source) => source.importEnabled);
  const syncWarning = activeSources.some(
    (source) =>
      source.syncStatus === 'ERROR' || source.syncStatus === 'BACKOFF' || source.circuitOpenedAt,
  );
  const importLabel = !sources.length
    ? 'Нет подключённых групп'
    : !activeSources.length
      ? 'Сбор постов на паузе'
      : isSyncing
        ? 'Обновляем посты'
        : syncWarning
          ? 'Есть задержки обновления'
          : 'Группы подключены';
  const importTone =
    syncWarning || isSyncing ? 'warning' : activeSources.length ? 'success' : 'muted';
  const effectiveSignature = postSignature ?? {
    enabled: settings.appendChannelLinkEnabled,
    presentation: 'signature' as const,
    text: settings.channelLinkText || CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
    url: '',
  };
  const editorIsReview =
    editingPost?.sourcePublishMode === 'REVIEW' || editingPost?.sourcePublishMode === 'BOT_REVIEW';
  const fallbackLink = editingPost ? resolveVkParsingFallbackLink(editingPost) : null;
  const publishing = Boolean(state.publishingPostId);
  function closeEditor() {
    if (publishing) return;
    if (state.isEditorDirty) setDiscardEditor(true);
    else state.cancelEditing();
  }
  const sourceControls = (
    <SourceDashboard
      settings={settings}
      botReviewSupported={entityType === 'channel' && botReview.data?.available !== false}
      botReviewEnabled={Boolean(botReview.data?.available && botReview.data.recipientConfigured)}
      sourceUrl={state.sourceUrl}
      sources={sources}
      selectedBulkSourceIds={state.selectedBulkSourceIds}
      isAdding={state.isAddingSource}
      isRefreshing={state.isRefreshing}
      isRemoving={state.isRemovingSource}
      isSavingSource={state.isSavingSource}
      isApplyingPreset={state.isApplyingPreset}
      refreshingSourceId={state.refreshingSourceId}
      onSourceUrlChange={state.setSourceUrl}
      onSubmitSource={state.submitSource}
      onRefresh={state.refreshSources}
      onRefreshSource={state.refreshSource}
      onToggleBulkSource={state.toggleBulkSource}
      onSelectAllBulkSources={state.selectAllBulkSources}
      onApplyPreset={state.applySourcePreset}
      onUpdateSource={state.updateSource}
      onRemoveSource={state.removeSource}
      onOpenAutomation={() => setView('automation')}
    />
  );

  return (
    <div className="vk-parsing-card vk-parsing-workspace">
      <div className="vk-workspace-toolbar">
        {feed ? (
          <span className={`vk-workflow-status is-${importTone}`}>
            <i aria-hidden />
            {importLabel}
          </span>
        ) : (
          <span>Посты из VK</span>
        )}
        <VkInfoButton title="О постах из VK">
          <p>
            Посты сохраняются в приложении. Для каждой группы доступны ручная публикация,
            автоматическая отправка и согласование в личке.
          </p>
          <p>
            Авто работает только с новыми записями. Первое подключение не публикует историю.
            Согласование в личке доступно круглосуточно.
          </p>
        </VkInfoButton>
        <button
          type="button"
          className="vk-parsing-icon-button"
          aria-label="Обновить посты"
          title="Обновить посты"
          disabled={state.isRefreshing || feedQuery.isFetching}
          onClick={() => {
            if (sources.length) state.refreshSources();
            else void feedQuery.refetch();
          }}
        >
          <IconoirSprite
            variant="iconoir"
            icon="RefreshCircle"
            className={state.isRefreshing || isSyncing ? 'is-refreshing' : undefined}
            aria-hidden
          />
        </button>
      </div>
      <div className="vk-workspace-tabs" role="tablist" aria-label="Раздел VK">
        {(
          [
            { id: 'posts', label: 'Посты' },
            { id: 'sources', label: 'Группы' },
            { id: 'automation', label: 'Автоматизация' },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            id={`${tabsId}-${tab.id}`}
            role="tab"
            aria-selected={view === tab.id}
            aria-controls={`${tabsId}-panel`}
            tabIndex={view === tab.id ? 0 : -1}
            onClick={() => setView(tab.id)}
            onKeyDown={(event) => {
              const values: WorkspaceView[] = ['posts', 'sources', 'automation'];
              if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                event.preventDefault();
                const next =
                  values[(values.indexOf(view) + (event.key === 'ArrowRight' ? 1 : 2)) % 3]!;
                setView(next);
                document.getElementById(`${tabsId}-${next}`)?.focus();
              }
            }}
          >
            {tab.label}
            {tab.id === 'sources' && sources.length ? <span>{sources.length}</span> : null}
          </button>
        ))}
      </div>
      {feedQuery.error ? (
        feed ? (
          <div className="vk-inline-warning" role="status">
            <IconoirSprite variant="iconoir" icon="WarningCircle" aria-hidden />
            <span>Не удалось обновить посты</span>
            <button type="button" onClick={() => void feedQuery.refetch()}>
              Повторить
            </button>
          </div>
        ) : (
          <StatusState
            tone="danger"
            title="Посты пока недоступны"
            description={normalizeApiError(feedQuery.error)}
            action={
              <button type="button" className="button" onClick={() => void feedQuery.refetch()}>
                Повторить
              </button>
            }
          />
        )
      ) : null}
      {!feed && feedQuery.isLoading ? <SkeletonCard lines={5} /> : null}
      {feed ? (
        <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${view}`}>
          {view === 'posts' ? (
            <>
              {!sources.length ? (
                sourceControls
              ) : (
                <>
                  <div className="vk-feed-toolbar">
                    <StatusFilterBar
                      statusFilter={state.statusFilter}
                      onSelectStatusFilter={state.selectStatusFilter}
                    />
                    {sources.length > 1 ? (
                      <select
                        aria-label="Группа в ленте"
                        value={state.selectedSourceId ?? ''}
                        onChange={(event) => state.selectSource(event.target.value || null)}
                      >
                        <option value="">Все группы</option>
                        {sources.map((source) => (
                          <option key={source.id} value={source.id}>
                            {source.title}
                          </option>
                        ))}
                      </select>
                    ) : null}
                  </div>
                  <div className="vk-feed-caption">
                    <span>
                      {state.statusFilter === 'QUEUED' ? 'Ожидают публикации' : 'Записи из VK'}
                    </span>
                    <span>{feed.pagination.total}</span>
                  </div>
                </>
              )}
              {posts.length === 0 ? (
                <div className="vk-workspace-empty">
                  <IconoirSprite variant="iconoir" icon="Post" aria-hidden />
                  <strong>
                    {isSyncing
                      ? 'Загружаем посты'
                      : state.statusFilter === 'QUEUED'
                        ? 'Очередь пуста'
                        : state.statusFilter === 'NEW'
                          ? 'Новых постов пока нет'
                          : 'Постов с таким статусом нет'}
                  </strong>
                  {sources.length > 0 && state.statusFilter !== 'ALL' ? (
                    <button
                      type="button"
                      className="vk-text-link"
                      onClick={() => state.selectStatusFilter('ALL')}
                    >
                      Все посты
                    </button>
                  ) : null}
                </div>
              ) : null}
              {state.statusFilter === 'QUEUED' ? (
                <Suspense fallback={<SkeletonCard lines={3} />}>
                  <LazyQueueTimeline
                    posts={posts}
                    timezone={settings.schedulerTimezone}
                    schedulingPostId={state.schedulingPostId}
                    cancelingPostId={state.cancelingPostId}
                    publishingNowPostId={state.publishingNowPostId}
                    onSchedulePost={state.schedulePost}
                    onCancelPost={state.cancelScheduledPost}
                    onPublishNow={state.publishPostNow}
                  />
                </Suspense>
              ) : (
                <PostList
                  posts={posts}
                  settings={settings}
                  postSignature={effectiveSignature}
                  channelLinkUrl={channelLinkUrl}
                  onSendForBotReview={
                    botReview.data?.isRecipient ? state.submitBotReview : undefined
                  }
                  submittingBotReviewPostId={state.submittingBotReviewPostId}
                  editingPostId={null}
                  publishingPostId={state.publishingPostId}
                  retryingPostId={state.retryingPostId}
                  draftText={state.draftText}
                  draftTextFormat={state.draftTextFormat}
                  selectedPhotoUrls={state.selectedPhotoUrls}
                  selectedVideoUrls={state.selectedVideoUrls}
                  selectedLinkUrls={state.selectedLinkUrls}
                  onStartEditing={state.startEditing}
                  onCancelEditing={state.cancelEditing}
                  onPublishEditingPost={state.publishEditingPost}
                  onRetryPost={state.retryPost}
                  onDraftTextChange={state.updateDraftText}
                  onTogglePhoto={state.togglePhoto}
                  onToggleVideo={state.toggleVideo}
                  onToggleLink={state.toggleLink}
                />
              )}
              <Pagination
                pagination={feed.pagination}
                postsLength={posts.length}
                pageOffset={state.pageOffset}
                isFetching={feedQuery.isFetching}
                onPageOffsetChange={state.setPageOffset}
              />
            </>
          ) : view === 'sources' ? (
            sourceControls
          ) : (
            <div className="vk-automation-view">
              <VkPublicationOptions
                settings={settings}
                disabled={state.isSavingSettings}
                onUpdate={state.updateSetting}
              />
              <SchedulerPanel
                settings={settings}
                sources={sources}
                status={status}
                queueCount={queueCount}
                publishedCount={sources.reduce((sum, source) => sum + source.publishedPostCount, 0)}
                isSaving={state.isSavingSettings}
                isSavingSource={state.isSavingSource}
                settingsSaved={state.settingsSaved}
                onUpdateSetting={state.updateSetting}
                onUpdateSources={state.updateSources}
              />
              {entityType === 'channel' ? (
                <BotReviewPanel api={api} chatId={chatId} active={active} />
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      <SettingsDrilldownPanel
        id="vk-post-editor"
        open={Boolean(editingPost)}
        title={editorIsReview ? 'Пост на согласование' : 'Публикация поста'}
        variant="screen"
        overlayClassName="vk-dialog-overlay"
        className="vk-parsing-surface vk-workspace-dialog vk-editor-dialog"
        onClose={closeEditor}
      >
        {editingPost ? (
          <Suspense fallback={<SkeletonCard lines={5} />}>
            <div className="vk-editor-origin">
              <strong>{editingPost.sourceTitle}</strong>
            </div>
            <LazyPostEditor
              post={editingPost}
              sourceLink={buildVkParsingSourceLink(editingPost.url, settings)}
              draftText={state.draftText}
              draftTextFormat={state.draftTextFormat}
              selectedPhotoUrls={state.selectedPhotoUrls}
              selectedVideoUrls={state.selectedVideoUrls}
              selectedLinkUrls={state.selectedLinkUrls}
              stripLinksEnabled={settings.stripLinksEnabled}
              appendChannelLinkEnabled={
                effectiveSignature.enabled && effectiveSignature.presentation === 'signature'
              }
              channelLinkText={effectiveSignature.text}
              channelLinkUrl={channelLinkUrl}
              customChannelLinkUrl={effectiveSignature.url}
              preserveLinkUrls={fallbackLink ? [fallbackLink] : undefined}
              isPublishing={publishing}
              onDraftTextChange={state.updateDraftText}
              onTogglePhoto={state.togglePhoto}
              onToggleVideo={state.toggleVideo}
              onToggleLink={state.toggleLink}
              onCancel={closeEditor}
              onPublish={state.publishEditingPost}
              submitLabel={editorIsReview ? 'Сохранить' : 'Опубликовать'}
              pendingLabel={editorIsReview ? 'Сохраняем...' : 'Отправляем...'}
            />
          </Suspense>
        ) : null}
      </SettingsDrilldownPanel>
      <ActionConfirmSheet
        id="vk-editor-discard"
        open={discardEditor}
        title="Не сохранять изменения?"
        summary="Несохранённые изменения этого поста будут потеряны."
        confirmLabel="Не сохранять"
        cancelLabel="Продолжить редактирование"
        onClose={() => setDiscardEditor(false)}
        onConfirm={() => {
          setDiscardEditor(false);
          state.cancelEditing();
        }}
      />
      <ActionConfirmSheet
        id="vk-preset-confirm"
        open={state.presetConfirmation !== null}
        title="Изменить настройки групп?"
        tone="accent"
        summary={
          state.presetConfirmation?.preset === 'CLEAN'
            ? 'Выбранные группы перейдут на публикацию по очереди. Фильтры рекламы и ссылок будут включены для всех групп.'
            : 'Выбранные группы перейдут на публикацию по очереди с новой частотой. Общий режим автопубликации не изменится.'
        }
        previewTitle={sources
          .filter((source) => state.presetConfirmation?.sourceIds.includes(source.id))
          .map((source) => source.title)
          .join(', ')}
        confirmLabel="Применить"
        isBusy={state.isApplyingPreset}
        onClose={state.closePresetConfirmation}
        onConfirm={() => void state.confirmSourcePreset()}
      />
    </div>
  );
}
