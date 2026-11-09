import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BulkUpdateVkParsingSourcesRequest,
  UpdateVkParsingSettingsRequest,
  UpdateVkParsingSourceRequest,
  VkParsingFeed,
  VkParsingFeedQuery,
  VkParsingPost,
  VkParsingPostFilterStatus,
} from '@maxim/contracts';
import {
  addVkParsingSource,
  applyVkParsingSourcePreset,
  cancelVkParsingPost,
  getVkParsing,
  publishVkParsingPost,
  publishVkParsingPostNow,
  refreshVkParsing,
  refreshVkParsingSource,
  removeVkParsingSource,
  retryVkParsingPost,
  scheduleVkParsingPost,
  submitVkBotReviewPost,
  updateVkParsingReviewDraft,
  updateVkParsingSource,
  updateVkParsingSettings,
  type VkParsingEntityType,
} from '../../lib/api/vk-parsing-client';
import type { ApiTransport } from '../../lib/api/transport';
import { maxNotify } from '../../lib/max-bridge';
import { queryKeys } from '../../lib/query-keys';
import { useToast } from '../ui/toast';
import { normalizeApiError, toggleValue } from './format';
import { resolveVkParsingInitialLinkSelection } from './link-selection';
import { vkDraftFingerprint, vkSourceLinkKey } from './workflow';
import {
  buildVkParsingSourceConnectionToast,
  mergeVkParsingMutationFeed,
  resolveVkParsingPollInterval,
} from './model';
import {
  VK_PARSING_INITIAL_STATUS_FILTER,
  VK_PARSING_PAGE_SIZE,
  type PublishPayload,
  type VkParsingHintKey,
  type VkParsingSettingKey,
} from './types';

type UseVkParsingCardParams = {
  api: ApiTransport;
  chatId: string;
  active: boolean;
  entityType: VkParsingEntityType;
};

export function useVkParsingCard({ api, chatId, active, entityType }: UseVkParsingCardParams) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [sourceUrl, setSourceUrl] = useState('');
  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  const [editingSnapshot, setEditingSnapshot] = useState<VkParsingPost | null>(null);
  const initialDraftRef = useRef('');
  const [draftText, setDraftText] = useState('');
  const [draftTextFormat, setDraftTextFormat] = useState<VkParsingPost['textFormat']>('plain');
  const [selectedPhotoUrls, setSelectedPhotoUrls] = useState<string[]>([]);
  const [selectedVideoUrls, setSelectedVideoUrls] = useState<string[]>([]);
  const [selectedLinkUrls, setSelectedLinkUrls] = useState<string[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<VkParsingPostFilterStatus>(
    VK_PARSING_INITIAL_STATUS_FILTER,
  );
  const [pageOffset, setPageOffset] = useState(0);
  const [openHintKey, setOpenHintKey] = useState<VkParsingHintKey | null>(null);
  const [selectedBulkSourceIds, setSelectedBulkSourceIds] = useState<string[]>([]);
  const [presetConfirmation, setPresetConfirmation] =
    useState<BulkUpdateVkParsingSourcesRequest | null>(null);
  const settingsUpdateInFlightRef = useRef(false);
  const [isSettingsUpdateInFlight, setIsSettingsUpdateInFlight] = useState(false);
  const sourceUpdateInFlightRef = useRef(false);
  const [isSourceUpdateInFlight, setIsSourceUpdateInFlight] = useState(false);
  const [saveFeedbackRevision, setSaveFeedbackRevision] = useState(0);
  useEffect(() => {
    if (!saveFeedbackRevision) return;
    const timer = window.setTimeout(() => setSaveFeedbackRevision(0), 4_000);
    return () => window.clearTimeout(timer);
  }, [saveFeedbackRevision]);

  const feedQueryScope = useMemo<Partial<VkParsingFeedQuery>>(
    () => ({
      status: statusFilter,
      sourceId: selectedSourceId ?? undefined,
      limit: VK_PARSING_PAGE_SIZE,
      offset: pageOffset,
    }),
    [pageOffset, selectedSourceId, statusFilter],
  );

  const feedQuery = useQuery({
    queryKey: queryKeys.vkParsing(entityType, chatId, feedQueryScope),
    queryFn: ({ signal }) => getVkParsing(api, entityType, chatId, feedQueryScope, signal),
    enabled: Boolean(chatId) && active,
    staleTime: 30_000,
    refetchInterval: (query) =>
      resolveVkParsingPollInterval({
        active,
        hasError: Boolean(query.state.error),
        feed: query.state.data,
      }),
    refetchOnWindowFocus: false,
  });

  function updateScopedFeedCache(nextFeed: VkParsingFeed) {
    queryClient.setQueryData<VkParsingFeed>(
      queryKeys.vkParsing(entityType, chatId, feedQueryScope),
      (currentFeed) => mergeVkParsingMutationFeed(currentFeed, nextFeed),
    );
  }

  const addSourceMutation = useMutation({
    mutationFn: (url: string) => addVkParsingSource(api, entityType, chatId, url),
    onSuccess: (result, requestedUrl) => {
      const previousSourceIds = new Set(feedQuery.data?.sources.map((source) => source.id) ?? []);
      const connectedSource =
        result.sources.find((source) => !previousSourceIds.has(source.id)) ??
        result.sources.find(
          (source) => vkSourceLinkKey(source.url) === vkSourceLinkKey(requestedUrl),
        );
      const alreadyConnected =
        result.queued === 0 &&
        previousSourceIds.size > 0 &&
        result.sources.every((source) => previousSourceIds.has(source.id));
      setSourceUrl('');
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      pushToast({
        tone: 'success',
        ...buildVkParsingSourceConnectionToast(connectedSource, alreadyConnected),
      });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Группа не добавлена',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const removeSourceMutation = useMutation({
    mutationFn: (sourceId: string) => removeVkParsingSource(api, entityType, chatId, sourceId),
    onSuccess: (_feed, sourceId) => {
      if (selectedSourceId === sourceId) {
        setSelectedSourceId(null);
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      pushToast({ tone: 'info', title: 'Группа отключена' });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Группа не отключена',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const refreshMutation = useMutation({
    mutationFn: () => refreshVkParsing(api, entityType, chatId),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      pushToast({
        tone: result.queued > 0 ? 'success' : 'info',
        title: result.queued > 0 ? 'Обновление запущено' : 'Нечего обновлять',
      });
      maxNotify(result.queued > 0 ? 'success' : 'warning');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Обновление не выполнено',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const updateSettingsMutation = useMutation({
    mutationFn: (payload: UpdateVkParsingSettingsRequest) =>
      updateVkParsingSettings(api, entityType, chatId, payload),
    onSuccess: (nextFeed) => {
      updateScopedFeedCache(nextFeed);
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      setSaveFeedbackRevision((revision) => revision + 1);
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Настройки не сохранены',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const updateSourceMutation = useMutation({
    mutationFn: ({
      sourceId,
      payload,
    }: {
      sourceId: string;
      payload: UpdateVkParsingSourceRequest;
    }) => updateVkParsingSource(api, entityType, chatId, sourceId, payload),
    onSuccess: (nextFeed) => {
      updateScopedFeedCache(nextFeed);
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      setSaveFeedbackRevision((revision) => revision + 1);
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Настройки группы не сохранены',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const updateSourcesMutation = useMutation({
    mutationFn: async ({
      sourceIds,
      payload,
    }: {
      sourceIds: string[];
      payload: UpdateVkParsingSourceRequest;
    }) => {
      let nextFeed = feedQuery.data ?? null;
      let saved = 0;
      for (const sourceId of sourceIds) {
        try {
          nextFeed = await updateVkParsingSource(api, entityType, chatId, sourceId, payload);
          saved += 1;
        } catch (error) {
          throw new Error(
            `Сохранено для ${saved} из ${sourceIds.length} групп. ${normalizeApiError(error)}`,
          );
        }
      }
      if (!nextFeed) {
        throw new Error('Группы не выбраны.');
      }
      return nextFeed;
    },
    onSuccess: (nextFeed) => {
      updateScopedFeedCache(nextFeed);
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      setSaveFeedbackRevision((revision) => revision + 1);
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не все настройки сохранены',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
    },
  });

  const sourcePresetMutation = useMutation({
    mutationFn: (payload: BulkUpdateVkParsingSourcesRequest) =>
      applyVkParsingSourcePreset(api, entityType, chatId, payload),
    onSuccess: (nextFeed) => {
      setSelectedBulkSourceIds([]);
      updateScopedFeedCache(nextFeed);
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      pushToast({ tone: 'success', title: 'Настройки применены' });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Настройки не применены',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const refreshSourceMutation = useMutation({
    mutationFn: (sourceId: string) => refreshVkParsingSource(api, entityType, chatId, sourceId),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      pushToast({
        tone: result.queued > 0 ? 'success' : 'info',
        title: result.queued > 0 ? 'Обновление запущено' : 'Нечего обновлять',
      });
      maxNotify(result.queued > 0 ? 'success' : 'warning');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Группа не обновлена',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const publishMutation = useMutation({
    mutationFn: (payload: PublishPayload) =>
      publishVkParsingPost(api, entityType, chatId, payload.postId, {
        text: payload.text,
        textFormat: payload.textFormat,
        photoUrls: payload.photoUrls,
        videoUrls: payload.videoUrls,
        linkUrls: payload.linkUrls,
      }),
    onSuccess: (result) => {
      setEditingPostId(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      pushToast({
        tone: result.queued > 0 ? 'success' : 'info',
        title: result.queued > 0 ? 'Пост поставлен в очередь' : 'Пост уже в очереди',
      });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Пост не поставлен в очередь',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const reviewDraftMutation = useMutation({
    mutationFn: (payload: PublishPayload) =>
      updateVkParsingReviewDraft(api, entityType, chatId, payload.postId, {
        text: payload.text,
        textFormat: payload.textFormat,
        photoUrls: payload.photoUrls,
        videoUrls: payload.videoUrls,
        linkUrls: payload.linkUrls,
      }),
    onSuccess: (nextFeed) => {
      setEditingPostId(null);
      updateScopedFeedCache(nextFeed);
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      pushToast({ tone: 'success', title: 'Изменения сохранены' });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не сохранено',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const botReviewMutation = useMutation({
    mutationFn: (postId: string) => submitVkBotReviewPost(api, chatId, postId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      void queryClient.invalidateQueries({ queryKey: ['vk-bot-review', chatId] });
      pushToast({ tone: 'success', title: 'Пост добавлен на согласование' });
    },
    onError: (error) =>
      pushToast({ tone: 'danger', title: 'Не отправлено', description: normalizeApiError(error) }),
  });

  const retryMutation = useMutation({
    mutationFn: (postId: string) => retryVkParsingPost(api, entityType, chatId, postId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      pushToast({ tone: 'success', title: 'Повтор поставлен в очередь' });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Повтор не запущен',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const scheduleMutation = useMutation({
    mutationFn: ({ postId, scheduledAt }: { postId: string; scheduledAt: string }) =>
      scheduleVkParsingPost(api, entityType, chatId, postId, { scheduledAt }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      pushToast({ tone: 'success', title: 'Время обновлено' });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Время не обновлено',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const cancelPostMutation = useMutation({
    mutationFn: (postId: string) => cancelVkParsingPost(api, entityType, chatId, postId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      pushToast({ tone: 'info', title: 'Публикация снята' });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Публикация не снята',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const publishNowMutation = useMutation({
    mutationFn: (postId: string) => publishVkParsingPostNow(api, entityType, chatId, postId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
      pushToast({ tone: 'success', title: 'Публикация запущена' });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось запустить публикацию',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const feed = feedQuery.data;
  const settings = feed?.settings ?? {
    chatId,
    sourceLinkEnabled: false,
    sourceLinkUrl: '',
    deleteAfterMinutes: null,
    autoPublishEnabled: false,
    autoPublishEnabledAt: null,
    autoPublishKillSwitchEnabled: false,
    stripLinksEnabled: false,
    skipAdsEnabled: false,
    appendChannelLinkEnabled: false,
    channelLinkText: 'Подписаться на канал',
    schedulerTimezone: 'Europe/Moscow',
    quietHoursStart: null,
    quietHoursEnd: null,
    workHoursStart: '09:00',
    workHoursEnd: '22:00',
    distributeEvenlyEnabled: true,
    roundRobinEnabled: true,
    circuitBreakerEnabled: true,
    circuitBreakerWindowMinutes: 10,
    circuitBreakerPostLimit: 10,
    updatedAt: null,
  };
  const posts = feed?.posts ?? [];
  const sources = feed?.sources ?? [];
  useEffect(() => {
    const eligibleIds = new Set(
      sources.filter((source) => source.publishMode !== 'BOT_REVIEW').map((source) => source.id),
    );
    if (!feed) return;
    setSelectedBulkSourceIds((current) => {
      const next = current.filter((id) => eligibleIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [feed, sources]);
  const editingPost = editingPostId ? editingSnapshot : null;

  useEffect(() => {
    if (!selectedSourceId || !feed || sources.some((source) => source.id === selectedSourceId)) {
      return;
    }

    setSelectedSourceId(null);
  }, [feed, selectedSourceId, sources]);

  useEffect(() => {
    if (!feed || feed.pagination.offset !== pageOffset || pageOffset === 0 || posts.length > 0)
      return;
    setPageOffset(
      Math.max(
        0,
        Math.floor(Math.max(0, feed.pagination.total - 1) / VK_PARSING_PAGE_SIZE) *
          VK_PARSING_PAGE_SIZE,
      ),
    );
  }, [feed, pageOffset, posts.length]);

  function startEditing(post: VkParsingPost) {
    const initialVideoUrls = post.videoUrls.slice(0, 1);
    const initialPhotoUrls = initialVideoUrls.length > 0 ? [] : post.photoUrls;
    const initialLinkUrls = resolveVkParsingInitialLinkSelection(post, settings.stripLinksEnabled);
    setEditingSnapshot(post);
    initialDraftRef.current = vkDraftFingerprint({
      text: post.text,
      textFormat: post.textFormat,
      photoUrls: initialPhotoUrls,
      videoUrls: initialVideoUrls,
      linkUrls: initialLinkUrls,
    });
    setEditingPostId(post.id);
    setDraftText(post.text);
    setDraftTextFormat(post.textFormat);
    setSelectedPhotoUrls(initialPhotoUrls);
    setSelectedVideoUrls(initialVideoUrls);
    setSelectedLinkUrls(initialLinkUrls);
  }

  function submitSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = sourceUrl.trim();
    if (!normalized || addSourceMutation.isPending) {
      return;
    }

    addSourceMutation.mutate(normalized);
  }

  function publishEditingPost() {
    if (!editingPost || publishMutation.isPending || reviewDraftMutation.isPending) {
      return;
    }

    const payload = {
      postId: editingPost.id,
      text: draftText,
      textFormat: draftTextFormat,
      photoUrls: selectedPhotoUrls,
      videoUrls: selectedVideoUrls,
      linkUrls: selectedLinkUrls,
    };

    if (
      editingPost.sourcePublishMode === 'REVIEW' ||
      editingPost.sourcePublishMode === 'BOT_REVIEW'
    ) {
      reviewDraftMutation.mutate(payload);
      return;
    }

    publishMutation.mutate(payload);
  }

  function toggleSetting(key: VkParsingSettingKey, checked: boolean) {
    void updateSetting({ [key]: checked });
  }

  async function updateSetting(payload: UpdateVkParsingSettingsRequest): Promise<boolean> {
    if (
      settingsUpdateInFlightRef.current ||
      sourceUpdateInFlightRef.current ||
      updateSettingsMutation.isPending
    ) {
      return false;
    }

    setSaveFeedbackRevision(0);
    settingsUpdateInFlightRef.current = true;
    setIsSettingsUpdateInFlight(true);
    try {
      try {
        await updateSettingsMutation.mutateAsync(payload);
        return true;
      } catch {
        return false;
      }
    } finally {
      settingsUpdateInFlightRef.current = false;
      setIsSettingsUpdateInFlight(false);
    }
  }

  async function updateSource(
    sourceId: string,
    payload: UpdateVkParsingSourceRequest,
  ): Promise<boolean> {
    if (
      sourceUpdateInFlightRef.current ||
      settingsUpdateInFlightRef.current ||
      updateSourceMutation.isPending ||
      updateSourcesMutation.isPending
    ) {
      return false;
    }

    setSaveFeedbackRevision(0);
    sourceUpdateInFlightRef.current = true;
    setIsSourceUpdateInFlight(true);
    try {
      try {
        await updateSourceMutation.mutateAsync({ sourceId, payload });
        return true;
      } catch {
        return false;
      }
    } finally {
      sourceUpdateInFlightRef.current = false;
      setIsSourceUpdateInFlight(false);
    }
  }

  async function updateSources(
    sourceIds: string[],
    payload: UpdateVkParsingSourceRequest,
  ): Promise<boolean> {
    if (
      updateSourceMutation.isPending ||
      updateSourcesMutation.isPending ||
      sourceUpdateInFlightRef.current ||
      settingsUpdateInFlightRef.current ||
      sourceIds.length === 0
    ) {
      return false;
    }

    setSaveFeedbackRevision(0);
    sourceUpdateInFlightRef.current = true;
    setIsSourceUpdateInFlight(true);
    try {
      await updateSourcesMutation.mutateAsync({ sourceIds, payload });
      return true;
    } catch {
      return false;
    } finally {
      sourceUpdateInFlightRef.current = false;
      setIsSourceUpdateInFlight(false);
    }
  }

  function toggleHint(key: VkParsingHintKey) {
    setOpenHintKey((current) => (current === key ? null : key));
  }

  async function confirmSourcePreset(): Promise<void> {
    if (!presetConfirmation || sourceUpdateInFlightRef.current || settingsUpdateInFlightRef.current)
      return;
    sourceUpdateInFlightRef.current = true;
    setIsSourceUpdateInFlight(true);
    try {
      await sourcePresetMutation.mutateAsync(presetConfirmation);
      setPresetConfirmation(null);
    } catch {
      void queryClient.invalidateQueries({ queryKey: queryKeys.vkParsing(entityType, chatId) });
    } finally {
      sourceUpdateInFlightRef.current = false;
      setIsSourceUpdateInFlight(false);
    }
  }

  function toggleBulkSource(sourceId: string) {
    setSelectedBulkSourceIds((current) =>
      current.includes(sourceId)
        ? current.filter((item) => item !== sourceId)
        : [...current, sourceId],
    );
  }

  function selectAllBulkSources() {
    const selectableIds = sources
      .filter((source) => source.publishMode !== 'BOT_REVIEW')
      .map((source) => source.id);
    setSelectedBulkSourceIds((current) =>
      current.length === selectableIds.length ? [] : selectableIds,
    );
  }

  return {
    feed,
    submitBotReview: (postId: string) => {
      if (!botReviewMutation.isPending) botReviewMutation.mutate(postId);
    },
    submittingBotReviewPostId: botReviewMutation.isPending ? botReviewMutation.variables : null,
    feedQuery,
    settings,
    settingsSaved: saveFeedbackRevision > 0,
    posts,
    sources,
    sourceUrl,
    selectedSourceId,
    statusFilter,
    pageOffset,
    openHintKey,
    selectedBulkSourceIds,
    presetConfirmation,
    closePresetConfirmation: () => setPresetConfirmation(null),
    confirmSourcePreset,
    editingPostId,
    editingPost,
    isEditorDirty:
      Boolean(editingPostId) &&
      initialDraftRef.current !==
        vkDraftFingerprint({
          text: draftText,
          textFormat: draftTextFormat,
          photoUrls: selectedPhotoUrls,
          videoUrls: selectedVideoUrls,
          linkUrls: selectedLinkUrls,
        }),
    draftText,
    draftTextFormat,
    selectedPhotoUrls,
    selectedVideoUrls,
    selectedLinkUrls,
    publishingPostId: publishMutation.isPending
      ? (publishMutation.variables?.postId ?? null)
      : reviewDraftMutation.isPending
        ? (reviewDraftMutation.variables?.postId ?? null)
        : null,
    retryingPostId: retryMutation.isPending ? (retryMutation.variables ?? null) : null,
    isAddingSource: addSourceMutation.isPending,
    isRemovingSource: removeSourceMutation.isPending,
    isRefreshing: refreshMutation.isPending,
    refreshingSourceId: refreshSourceMutation.isPending
      ? (refreshSourceMutation.variables ?? null)
      : null,
    isSavingSettings:
      isSettingsUpdateInFlight || updateSettingsMutation.isPending || isSourceUpdateInFlight,
    isSavingSource:
      isSourceUpdateInFlight ||
      isSettingsUpdateInFlight ||
      updateSourceMutation.isPending ||
      updateSourcesMutation.isPending,
    isApplyingPreset: sourcePresetMutation.isPending,
    schedulingPostId: scheduleMutation.isPending
      ? (scheduleMutation.variables?.postId ?? null)
      : null,
    cancelingPostId: cancelPostMutation.isPending ? (cancelPostMutation.variables ?? null) : null,
    publishingNowPostId: publishNowMutation.isPending
      ? (publishNowMutation.variables ?? null)
      : null,
    setSourceUrl,
    updateDraftText: (value: string) => {
      setDraftText(value);
      setDraftTextFormat('markdown');
    },
    setPageOffset,
    submitSource,
    refreshSources: () => refreshMutation.mutate(),
    refreshSource: (sourceId: string) => refreshSourceMutation.mutate(sourceId),
    removeSource: (sourceId: string) => removeSourceMutation.mutate(sourceId),
    selectSource: (sourceId: string | null) => {
      setPageOffset(0);
      setSelectedSourceId(sourceId);
    },
    selectStatusFilter: (status: VkParsingPostFilterStatus) => {
      setPageOffset(0);
      setStatusFilter(status);
    },
    toggleHint,
    toggleSetting,
    updateSetting,
    updateSource,
    updateSources,
    toggleBulkSource,
    selectAllBulkSources,
    applySourcePreset: (preset: BulkUpdateVkParsingSourcesRequest['preset']) => {
      if (selectedBulkSourceIds.length > 0) {
        setPresetConfirmation({ sourceIds: [...selectedBulkSourceIds], preset });
      }
    },
    applyPresetToAllSources: (preset: BulkUpdateVkParsingSourcesRequest['preset']) => {
      const sourceIds = feedQuery.data?.sources.map((source) => source.id) ?? [];
      if (sourceIds.length > 0) {
        setPresetConfirmation({ sourceIds, preset });
      }
    },
    schedulePost: (postId: string, scheduledAt: string) =>
      scheduleMutation.mutate({ postId, scheduledAt }),
    cancelScheduledPost: (postId: string) => cancelPostMutation.mutate(postId),
    publishPostNow: (postId: string) => publishNowMutation.mutate(postId),
    startEditing,
    cancelEditing: () => {
      setEditingPostId(null);
      setEditingSnapshot(null);
    },
    publishEditingPost,
    retryPost: (postId: string) => retryMutation.mutate(postId),
    togglePhoto: (url: string) => {
      setSelectedVideoUrls([]);
      setSelectedPhotoUrls((current) => toggleValue(current, url));
    },
    toggleVideo: (url: string) => {
      setSelectedPhotoUrls([]);
      setSelectedVideoUrls((current) => (current.includes(url) ? [] : [url]));
    },
    toggleLink: (url: string) => setSelectedLinkUrls((current) => toggleValue(current, url)),
  };
}
