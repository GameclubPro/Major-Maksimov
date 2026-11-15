import { ApiRequestError } from '../lib/api-request-error';
import { runNativeBackHandlers } from '../lib/native-back';
import { AppIcon as IconoirSprite } from '../components/ui/app-icon';
import { SettingsOverviewGroups } from '../components/ui/settings-overview-groups';
import { getNetworkSettingsSectionPresentation } from './settings/settings-workspace-sections';
import { ChannelQuickButtonsFields } from './settings/channel-quick-buttons-fields';
import { ChannelCommentsFields } from './settings/channel-comments-fields';
import { ChannelPostSuggestionsFields } from './settings/channel-post-suggestions-fields';
import { ChannelPostSignatureFields } from './settings/channel-post-signature-fields';
import { createChannelSettingsFieldAdapter } from '../features/network-settings/settings-field-bindings';
import { SettingsOverviewSearchPlaceholder } from '../components/ui/settings-overview-search-placeholder';
import { SettingsOverviewLoading } from '../components/ui/settings-overview-skeleton';
import {
  CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
  type ChannelPostSignatureSettings,
} from '@maxim/contracts/channel-post-signature';
import type {
  BroadcastImage,
  BroadcastLinkButton,
  ManagedAutopostRuleDetails,
  ManagedAutopostRuleSummary,
  ManagedBroadcastDetails,
} from '@maxim/contracts/broadcast';
import type { ChannelSettings, ChannelSettingsScreenResponse } from '@maxim/contracts/settings';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MarketplaceProfileCard } from '../components/marketplace-profile-card';
const MarketplaceModuleToggle = lazy(() => import('../components/marketplace-module-toggle'));

import '../styles/settings-drilldown-core.css';
import '../styles/settings-native-controls.css';
import '../styles/settings-home-compact.css';
import '../styles/settings-home-route-polish.css';
import '../styles/broadcast-studio-base.css';
import '../styles/settings-drilldown-polish.css';
import '../styles/settings-route-polish.css';
import '../styles/settings-interaction-polish.css';
import '../styles/managed-giveaway.css';
import '../styles/broadcast-studio.css';
import '../styles/broadcast-autopost-polish.css';
import '../styles/settings-tile-grid.css';
import '../styles/settings-native-polish.css';
import '../styles/settings-experience.css';
import '../styles/channel-post-signature-entry.css';
import '../styles/channel-post-signature.css';
import '../styles/channel-post-actions-save.css';
import {
  Suspense,
  lazy,
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import type { BroadcastSchedulePlannerSelectionState } from '../components/broadcast-schedule-planner';
import type { ManagedGiveawayCardHandle } from '../components/managed-giveaway-card';
import type { ManagedPollWorkspaceHandle } from '../components/managed-poll-workspace';
import {
  BroadcastHistoryFilterTabs,
  BroadcastWorkspaceChrome,
  countManagedBroadcastHistoryFilters,
  filterManagedBroadcastsByHistoryFilter,
  type BroadcastHistoryFilter,
  type BroadcastWorkspaceView,
} from '../components/broadcast-studio-workspace';
import { MaxMarkdownPreview } from '../components/max-markdown-preview';
import { ManagedEntityWorkspaceHeader } from '../components/ui/managed-entity-workspace-header';
import '../components/ui/managed-entity-settings-header.css';
import '../styles/settings-overview-steel.css';
import '../styles/settings-steel.css';
import { getInitDataUserId } from '../lib/init-data';
import { GlassCard } from '../components/ui/glass-card';
import { ActionConfirmSheet } from '../components/ui/action-confirm-sheet';
import { SkeletonCard } from '../components/ui/skeleton';
import { SettingsDrilldownPanel } from '../components/ui/settings-drilldown-panel';
import {
  SettingsSectionIcon,
  SettingsSectionToggle,
} from '../components/ui/settings-section-toggle';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import {
  cancelChannelManagedBroadcast,
  clearChannelBroadcastHandoffState,
  createBroadcastRequestId,
  deleteChannelManagedAutopostRule,
  getChannelBroadcastComposerClientResetState,
  getChannelBroadcastHandoffState,
  getChannelManagedAutopostRules,
  getChannelManagedBroadcastCalendar,
  getChannelManagedBroadcast,
  getChannelSettingsScreen,
  getChannelPostSignature,
  recheckChannelManagedEntityAccess,
  retryChannelManagedBroadcast,
  sendChannelBroadcast,
  sendChannelBroadcastTest,
  updateChannelPostSignature,
  updateChannelManagedAutopostRule,
  updateChannelManagedBroadcast,
  updateChannelSettings,
} from '../lib/api/channel-settings-client';
import type { ApiTransport } from '../lib/api/transport';
import { shouldRetryTransientApiError } from '../lib/api-retry';
import { describeUserFacingError } from '../lib/user-facing-error';
import { buildBroadcastSendFeedback } from '../lib/broadcast-send-feedback';
import { findTerminalSettingsLoadError } from '../lib/settings-load-error';
import type { BroadcastHandoffPayload, SendBroadcastPayload } from '../lib/api/shared-types';
import {
  buildBroadcastLinkButtonLegacyFields,
  createEmptyBroadcastLinkButton,
  formatBroadcastButtonsPreview,
  formatBroadcastButtonsStatus,
  hasBroadcastLinkButtonErrors,
  trimBroadcastLinkButtons,
  validateBroadcastLinkButtons,
  type BroadcastLinkButtonFieldErrors,
} from '../lib/broadcast-link-buttons';
import {
  buildManagedAutopostRuleFacts,
  normalizeManagedAutopostPayload,
  sortManagedAutopostRules,
} from '../lib/managed-autopost-ui';
import {
  createDefaultBroadcastCycleDraft,
  findBroadcastSlotConflicts,
  formatBroadcastCycleSummary,
  getBroadcastCycleValidationError,
  hasBroadcastHandoffDraft,
  normalizeBroadcastCycleDraft,
  resolveBroadcastHandoffLoadMode,
  resolveBroadcastHandoffSchedule,
  resolveBroadcastCycleSendAt,
  resolveBroadcastScheduleConflict,
  resolveBroadcastScheduleTimezone,
  sortAndUniqueBroadcastSlots,
  type BroadcastCycleDraft,
  type BroadcastTimingMode,
} from '../lib/broadcast-schedule';
import {
  clearBroadcastComposerDraft,
  hasAppliedBroadcastComposerReset,
  loadBroadcastComposerDraftAsync,
  markBroadcastComposerResetApplied,
  saveBroadcastComposerDraft,
  type BroadcastComposerDraft,
} from '../lib/broadcast-composer-draft';
import { normalizeComposerBroadcastImages } from '../lib/broadcast-image-list-basic';
import { buildChannelBroadcastSystemButtons } from '../lib/broadcast-system-buttons';
import { saveUntilLatestDraftIsPersisted } from '../lib/latest-draft-save';
import { buildBroadcastAudiencePresentation } from '../lib/broadcast-audience-presentation';
import { cn } from '../lib/cn';
import { maxNotify, setMaxClosingConfirmation } from '../lib/max-bridge';
import { useManagedEntityLeaveGuard } from '../lib/managed-entity-navigation';
import {
  buildManagedEntityStatisticsRoute,
  readManagedEntityWorkspaceState,
} from '../lib/managed-entity-workspace';
import {
  parseChannelPostSignatureUrl,
  resolveChannelPostSignaturePreviewUrl,
  normalizePostSignatureSettings,
  validatePostSignatureSettings,
  buildPostSignaturePatch,
  reconcilePostSignatureSave,
} from '../lib/channel-post-signature';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { buildManagedEntitiesRoute, saveLastEntityId } from '../lib/last-chat';
import { queryKeys } from '../lib/query-keys';
import { useAutoHideHeader } from '../lib/use-auto-hide-header';
import {
  resolveLegacyBroadcastEditorTarget,
  resolveLegacyPublicationReturnPath,
} from '../features/publications/legacy-autoposts';
import { BroadcastPublishBar, SettingsLoadErrorState } from './settings/settings-lazy-surfaces';

type ChannelRouteState = {
  chatTitle: string;
  chatLink: string;
  avatarUrl: string | null;
};
type ManagedBroadcastListItem = ChannelSettingsScreenResponse['managedBroadcasts'][number];
type BroadcastCountdownPresentation = {
  label: string;
  value: string;
  caption: string;
};
type ManagedBroadcastCardTone = 'active' | 'warning' | 'danger' | 'muted';
type PendingBroadcastPublishReview = {
  broadcastId: string | null;
  payload: SendBroadcastPayload;
};

function postSignatureSettingsKey(value: ChannelPostSignatureSettings): string {
  return JSON.stringify(normalizePostSignatureSettings(value), (key, field) =>
    key === 'revision' ? undefined : field,
  );
}

function channelSettingsDraftKey(value: ChannelSettings): string {
  return JSON.stringify(value, (key, field) => (key === 'revision' ? undefined : field));
}

function normalizeBroadcastImageList(images: BroadcastImage[]): BroadcastImage[] {
  return normalizeComposerBroadcastImages(images);
}

function resolveBroadcastImagesFromLegacyFields(value: {
  imageEnabled?: boolean;
  imageBase64?: string | null;
  imageMimeType?: string | null;
  imageFileName?: string | null;
  images?: BroadcastImage[] | null;
}): BroadcastImage[] {
  const images = normalizeBroadcastImageList(value.images ?? []);
  const imageBase64 = value.imageBase64?.trim() ?? '';
  if (images.length > 0 || !value.imageEnabled || !imageBase64) {
    return images;
  }

  return [
    {
      base64: imageBase64,
      mimeType: value.imageMimeType?.trim() ?? '',
      fileName: value.imageFileName?.trim() ?? '',
    },
  ];
}

function areBroadcastImagesReady(images: BroadcastImage[]): boolean {
  return (
    images.length > 0 &&
    images.every((image) => image.base64 && image.mimeType.toLowerCase().startsWith('image/'))
  );
}

type ChannelSettingsSectionKey =
  | 'quickButtons'
  | 'postSignature'
  | 'comments'
  | 'postSuggestions'
  | 'broadcast'
  | 'polls'
  | 'giveaway';
type BroadcastVideoSource = {
  mediaType?: string | null;
  mediaPayload?: Record<string, unknown> | null;
  mediaMimeType?: string | null;
  mediaFileName?: string | null;
};

const MIN_BROADCAST_CYCLE_HOURS = 1;
const BROADCAST_HOUR_MS = 60 * 60 * 1_000;
const MAX_BROADCAST_TEXT_LENGTH = 2_000;
const DESKTOP_TOGGLE_ROW_BLOCKERS = [
  'a',
  'button',
  'input',
  'label',
  'select',
  'summary',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[contenteditable="true"]',
  '.channel-settings-hint-anchor',
  '.channel-settings-hint-popover',
  '.settings-native-toggle__hint',
].join(', ');
const INITIAL_EXPANDED_CHANNEL_SECTIONS: Record<ChannelSettingsSectionKey, boolean> = {
  quickButtons: false,
  postSignature: false,
  comments: false,
  postSuggestions: false,
  broadcast: false,
  polls: false,
  giveaway: false,
};
const EMPTY_BROADCAST_PLANNER_STATE: BroadcastSchedulePlannerSelectionState = {
  pickedDayCount: 0,
  selectedDayCount: 0,
  slotCount: 0,
  futureSlotCount: 0,
  isDaySheetOpen: false,
  isConfirmed: false,
  hasBlockingIssue: false,
};

function areBroadcastPlannerStatesEqual(
  left: BroadcastSchedulePlannerSelectionState,
  right: BroadcastSchedulePlannerSelectionState,
): boolean {
  return (
    left.pickedDayCount === right.pickedDayCount &&
    left.selectedDayCount === right.selectedDayCount &&
    left.slotCount === right.slotCount &&
    left.futureSlotCount === right.futureSlotCount &&
    left.isDaySheetOpen === right.isDaySheetOpen &&
    left.isConfirmed === right.isConfirmed &&
    left.hasBlockingIssue === right.hasBlockingIssue
  );
}

const LazyManagedEntityBotsControl = lazy(
  () => import('../components/managed-entity-bots-control'),
);
const LazySettingsHandoffState = lazy(() => import('../components/handoff'));
const LazyBroadcastSchedulePlanner = lazy(() =>
  import('../components/broadcast-schedule-planner').then((module) => ({
    default: module.BroadcastSchedulePlanner,
  })),
);
const LazyBroadcastContentComposer = lazy(() => import('../components/broadcast-content-composer'));
const LazyBroadcastButtonsSheet = lazy(() => import('../components/broadcast-buttons-sheet'));
const LazyBroadcastPublishReviewSheet = lazy(
  () => import('../components/broadcast-publish-review-sheet'),
);
const LazyManagedAutopostRuleCard = lazy(() =>
  import('../components/managed-autopost-rule-card').then((module) => ({
    default: module.ManagedAutopostRuleCard,
  })),
);
const LazyManagedBroadcastHistoryCard = lazy(() =>
  import('../components/managed-broadcast-history-card').then((module) => ({
    default: module.ManagedBroadcastHistoryCard,
  })),
);
const LazyManagedEntityAccessDiagnosticsBanner = lazy(() =>
  import('../components/managed-entity-access-diagnostics').then((module) => ({
    default: module.ManagedEntityAccessDiagnosticsBanner,
  })),
);
const LazyManagedGiveawayCard = lazy(() =>
  import('../components/managed-giveaway-card').then((module) => ({
    default: module.ManagedGiveawayCard,
  })),
);
const LazyManagedPollWorkspace = lazy(() =>
  import('../components/managed-poll-workspace').then((module) => ({
    default: module.ManagedPollWorkspace,
  })),
);
const LazySettingsOverviewSearch = lazy(() =>
  import('../components/ui/settings-overview-search').then((module) => ({
    default: module.SettingsOverviewSearch,
  })),
);

function formatDateTimeInTimeZone(
  value: string | null,
  options: Intl.DateTimeFormatOptions,
  timeZone?: string | null,
): string {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return '';
  }

  const formatterOptions = timeZone?.trim() ? { ...options, timeZone } : options;
  return new Intl.DateTimeFormat('ru-RU', formatterOptions).format(date);
}

function toLocalTimeInputValue(value: Date): string {
  const hours = String(value.getHours()).padStart(2, '0');
  const minutes = String(value.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function getRouteState(state: unknown): ChannelRouteState {
  if (!state || typeof state !== 'object') {
    return { chatTitle: '', chatLink: '', avatarUrl: null };
  }

  const row = state as Record<string, unknown>;
  const chatTitle =
    typeof row.chatTitle === 'string' && row.chatTitle.trim() ? row.chatTitle.trim() : '';
  const candidateLink =
    typeof row.chatLink === 'string' && row.chatLink.trim() ? row.chatLink.trim() : '';
  const chatLink = isHttpUrl(candidateLink) ? candidateLink : '';
  const avatarUrl =
    typeof row.avatarUrl === 'string' && row.avatarUrl.trim() ? row.avatarUrl.trim() : null;

  return { chatTitle, chatLink, avatarUrl };
}

function resolveDesktopToggleRowLabel(target: EventTarget | null): HTMLLabelElement | null {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function' ||
    !window.matchMedia('(hover: hover) and (pointer: fine)').matches ||
    !(target instanceof HTMLElement)
  ) {
    return null;
  }

  if (window.getSelection()?.type === 'Range') {
    return null;
  }

  if (target.closest(DESKTOP_TOGGLE_ROW_BLOCKERS)) {
    return null;
  }

  const row = target.closest('.settings-native-toggle__row');
  if (!row) {
    return null;
  }

  const switchLabel = row.querySelector<HTMLLabelElement>('.settings-native-switch');
  const switchInput = switchLabel?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!switchLabel || !switchInput || switchInput.disabled) {
    return null;
  }

  return switchLabel;
}

function normalizeApiError(error: unknown): string {
  return describeUserFacingError(error, 'Не удалось выполнить действие.');
}

function formatChannelCountLabel(
  count: number,
  singular: string,
  few: string,
  plural: string,
): string {
  const safeCount = Math.max(0, Math.trunc(count));
  const remainder100 = safeCount % 100;
  const remainder10 = safeCount % 10;

  if (remainder100 >= 11 && remainder100 <= 19) {
    return `${safeCount} ${plural}`;
  }

  if (remainder10 === 1) {
    return `${safeCount} ${singular}`;
  }

  if (remainder10 >= 2 && remainder10 <= 4) {
    return `${safeCount} ${few}`;
  }

  return `${safeCount} ${plural}`;
}

function formatManagedBroadcastDateTime(value: string | null, timeZone?: string | null): string {
  return formatDateTimeInTimeZone(
    value,
    {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    },
    timeZone,
  );
}

function formatCompactManagedBroadcastDateTime(
  value: string | null,
  timeZone?: string | null,
): string {
  return formatDateTimeInTimeZone(
    value,
    {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    },
    timeZone,
  );
}

function formatBroadcastPayloadScheduleLabel(payload: SendBroadcastPayload): string {
  if (payload.scheduleMode === 'calendar') {
    const slots = sortAndUniqueBroadcastSlots(payload.scheduledSlots);
    if (slots.length === 1) {
      return formatCompactManagedBroadcastDateTime(slots[0], payload.scheduleTimezone);
    }

    return formatChannelCountLabel(slots.length, 'отправка', 'отправки', 'отправок');
  }

  if (payload.cycleEnabled) {
    return `Повтор · ${formatBroadcastCycleSummary(
      {
        startMode: payload.sendAt ? 'later' : 'now',
        startAt: payload.sendAt ?? new Date().toISOString(),
        everyHours: payload.cycleEveryHours,
        count: payload.cycleCount,
      },
      Date.now(),
    )}`;
  }

  if (payload.sendAt) {
    return formatCompactManagedBroadcastDateTime(payload.sendAt, payload.scheduleTimezone);
  }

  return 'Сейчас';
}

function formatBroadcastCountdownValue(remainingMs: number): string {
  const totalMinutes = Math.max(0, Math.floor(remainingMs / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `${days}д ${String(hours).padStart(2, '0')}ч`;
  }

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}ч ${String(minutes).padStart(2, '0')}м`;
  }

  if (minutes > 0) {
    return `${minutes}м`;
  }

  return '<1м';
}

function resolveBroadcastCountdown(
  nextSendAt: string | null,
  nowMs: number,
  scheduleTimezone?: string | null,
): BroadcastCountdownPresentation | null {
  if (!nextSendAt) {
    return null;
  }

  const targetMs = new Date(nextSendAt).getTime();
  if (!Number.isFinite(targetMs) || targetMs <= nowMs) {
    return null;
  }

  return {
    label: 'До отправки',
    value: formatBroadcastCountdownValue(targetMs - nowMs),
    caption: formatCompactManagedBroadcastDateTime(nextSendAt, scheduleTimezone),
  };
}

function resolveManagedBroadcastCardTone(
  broadcast: ManagedBroadcastListItem,
): ManagedBroadcastCardTone {
  if (broadcast.status === 'FAILED') {
    return 'danger';
  }
  if (broadcast.status === 'PARTIAL') {
    return 'warning';
  }
  if (broadcast.status === 'COMPLETED' || broadcast.status === 'CANCELED') {
    return 'muted';
  }
  return 'active';
}

function resolveManagedBroadcastCardBadge(broadcast: ManagedBroadcastListItem): string {
  if (broadcast.status === 'PARTIAL') {
    return 'Нужно действие';
  }
  if (broadcast.status === 'FAILED') {
    return 'Пауза';
  }
  if (broadcast.status === 'COMPLETED') {
    return 'Завершена';
  }
  if (broadcast.status === 'CANCELED') {
    return 'Остановлена';
  }
  return 'В работе';
}

function resolveManagedBroadcastCardTitle(broadcast: ManagedBroadcastListItem): string {
  if (broadcast.status === 'PARTIAL') {
    return 'Есть ошибки доставки';
  }
  if (broadcast.status === 'FAILED') {
    return 'Нужно повторить отправку';
  }
  if (broadcast.status === 'COMPLETED') {
    return 'Публикация завершена';
  }
  if (broadcast.status === 'CANCELED') {
    return 'Публикация остановлена';
  }
  return broadcast.nextSendAt ? 'Следующая отправка' : 'Публикация в работе';
}

function resolveManagedBroadcastMetric(
  broadcast: ManagedBroadcastListItem,
  nowMs: number,
): BroadcastCountdownPresentation & { tone: ManagedBroadcastCardTone } {
  const countdown = resolveBroadcastCountdown(
    broadcast.nextSendAt,
    nowMs,
    broadcast.scheduleTimezone,
  );
  if (countdown && (broadcast.status === 'ACTIVE' || broadcast.status === 'PARTIAL')) {
    return {
      ...countdown,
      tone: broadcast.status === 'PARTIAL' ? 'warning' : 'active',
    };
  }

  if (broadcast.failedChats > 0) {
    return {
      label: 'Ошибки',
      value: String(broadcast.failedChats),
      caption: formatChannelCountLabel(broadcast.failedChats, 'чат', 'чата', 'чатов'),
      tone: broadcast.status === 'FAILED' ? 'danger' : 'warning',
    };
  }

  if (broadcast.pendingChats > 0) {
    return {
      label: 'В очереди',
      value: String(broadcast.pendingChats),
      caption: formatChannelCountLabel(broadcast.pendingChats, 'чат', 'чата', 'чатов'),
      tone: 'active',
    };
  }

  return {
    label: 'Доставлено',
    value: `${broadcast.deliveredChats}/${broadcast.targetChats}`,
    caption: buildBroadcastAudiencePresentation({
      targetMode: broadcast.targetMode,
      targetChatIds: broadcast.targetChatIds,
      targetPreviews: broadcast.targetPreviews,
      targetOverflowCount: broadcast.targetOverflowCount,
      targetChats: broadcast.targetChats,
      currentLabel: 'Текущий канал',
    }).label,
    tone: broadcast.status === 'COMPLETED' ? 'muted' : 'active',
  };
}

function buildManagedBroadcastFactChips(broadcast: ManagedBroadcastListItem): string[] {
  const scopeLabel = buildBroadcastAudiencePresentation({
    targetMode: broadcast.targetMode,
    targetChatIds: broadcast.targetChatIds,
    targetPreviews: broadcast.targetPreviews,
    targetOverflowCount: broadcast.targetOverflowCount,
    targetChats: broadcast.targetChats,
    currentLabel: 'Текущий канал',
  }).label;
  const scheduleLabel =
    broadcast.scheduleMode === 'calendar'
      ? formatChannelCountLabel(broadcast.scheduledSlots.length, 'отправка', 'отправки', 'отправок')
      : broadcast.cycleEnabled
        ? `Цикл ${broadcast.sentCount}/${broadcast.cycleCount}`
        : '1 отправка';
  const extras = [
    broadcast.buttonEnabled ? formatBroadcastButtonsStatus(broadcast.buttons) : null,
    broadcast.hasImage
      ? broadcast.imageCount > 1
        ? `${broadcast.imageCount} фото`
        : 'Фото'
      : null,
    broadcast.hasVideo ? 'Видео' : null,
  ]
    .filter((item): item is string => Boolean(item))
    .join(' · ');

  return [
    scopeLabel,
    scheduleLabel,
    extras || null,
    broadcast.pendingChats > 0 ? `В очереди ${broadcast.pendingChats}` : null,
  ].filter((item): item is string => Boolean(item));
}

function normalizeChannelSettingsDraft(
  draft: ChannelSettings,
  resolvedChannelLink: string,
): ChannelSettings {
  return {
    ...draft,
    engagementMessageText:
      draft.engagementMessageText.trim() || 'Есть идея или обратная связь? Нажмите кнопку ниже.',
    postSuggestionsDailyLimit: Math.max(
      1,
      Math.min(10, Math.trunc(draft.postSuggestionsDailyLimit || 10)),
    ),
    postSuggestionsButtonText: draft.postSuggestionsButtonText.trim() || 'Предложить пост',
    postSuggestionsButtonUrl:
      draft.postSuggestionsButtonEnabled && resolvedChannelLink
        ? resolvedChannelLink
        : draft.postSuggestionsButtonUrl,
  };
}

const SHARED_CHANNEL_SECTION_PRESENTATIONS = {
  postSignature: getNetworkSettingsSectionPresentation('channel', 'postSignature'),
  quickButtons: getNetworkSettingsSectionPresentation('channel', 'quickButtons'),
  comments: getNetworkSettingsSectionPresentation('channel', 'comments'),
} as const;

export function ChannelSettingsPage({ api }: { api: ApiTransport }) {
  const userId = getInitDataUserId()?.trim() || null;
  const { chatId = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isCompact: isHeaderCompact } = useAutoHideHeader();
  const routeState = getRouteState(location.state);
  const routeChatTitle = routeState.chatTitle;
  const routeChatLink = routeState.chatLink;
  const routeAvatarUrl = routeState.avatarUrl;
  const [draft, setDraft] = useState<ChannelSettings | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<ChannelSettings | null>(null);
  const [customButtonEditorOpen, setCustomButtonEditorOpen] = useState(false);
  const [postSignatureDraft, setPostSignatureDraft] = useState<ChannelPostSignatureSettings | null>(
    null,
  );
  const [savedPostSignature, setSavedPostSignature] = useState<ChannelPostSignatureSettings | null>(
    null,
  );
  const [postSignatureSaveState, setPostSignatureSaveState] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');
  const [postSignatureSaveError, setPostSignatureSaveError] = useState('');
  const [autosaveState, setAutosaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [isSavingChannelSettingsForBroadcast, setIsSavingChannelSettingsForBroadcast] =
    useState(false);
  const saveInFlightRef = useRef<Promise<ChannelSettings> | null>(null);
  const postSignatureSaveInFlightRef = useRef<{
    chatId: string;
    promise: Promise<void>;
  } | null>(null);
  const activePostSignatureChatIdRef = useRef(chatId);
  const latestPostSignatureRef = useRef<ChannelPostSignatureSettings | null>(null);
  const latestPostSignatureKeyRef = useRef('');
  const savedPostSignatureKeyRef = useRef('');
  const savedPostSignatureRef = useRef<ChannelPostSignatureSettings | null>(null);
  const postSignatureInitializedChatIdRef = useRef('');
  const broadcastSettingsSaveInFlightRef = useRef(false);
  const lastFailedDraftKeyRef = useRef<string | null>(null);
  const latestNormalizedDraftRef = useRef<ChannelSettings | null>(null);
  const latestDraftKeyRef = useRef('');
  const isDirtyRef = useRef(false);
  const pollWorkspaceRef = useRef<ManagedPollWorkspaceHandle | null>(null);
  const giveawayCardRef = useRef<ManagedGiveawayCardHandle | null>(null);
  const [expandedSections, setExpandedSections] = useState<
    Record<ChannelSettingsSectionKey, boolean>
  >(INITIAL_EXPANDED_CHANNEL_SECTIONS);
  const { pushToast } = useToast();
  const [broadcastText, setBroadcastText] = useState('');
  const [broadcastTextError, setBroadcastTextError] = useState('');
  const [broadcastButtons, setBroadcastButtons] = useState<BroadcastLinkButton[]>([]);
  const [broadcastButtonsSheetOpen, setBroadcastButtonsSheetOpen] = useState(false);
  const [broadcastButtonRevealSignal, setBroadcastButtonRevealSignal] = useState(0);
  const [broadcastButtonErrors, setBroadcastButtonErrors] = useState<
    BroadcastLinkButtonFieldErrors[]
  >([]);
  activePostSignatureChatIdRef.current = chatId;
  const [broadcastImageEnabled, setBroadcastImageEnabled] = useState(false);
  const [broadcastImageBase64, setBroadcastImageBase64] = useState('');
  const [broadcastImageMimeType, setBroadcastImageMimeType] = useState('');
  const [broadcastImageFileName, setBroadcastImageFileName] = useState('');
  const [broadcastImages, setBroadcastImages] = useState<BroadcastImage[]>([]);
  const [broadcastImagesPreparing, setBroadcastImagesPreparing] = useState(false);
  const [broadcastVideoCleared, setBroadcastVideoCleared] = useState(false);
  const [broadcastScheduledSlots, setBroadcastScheduledSlots] = useState<string[]>([]);
  const [broadcastTimingMode, setBroadcastTimingMode] = useState<BroadcastTimingMode>('now');
  const [broadcastCycleDraft, setBroadcastCycleDraft] = useState<BroadcastCycleDraft>(() =>
    createDefaultBroadcastCycleDraft(),
  );
  const [broadcastScheduleTimezone, setBroadcastScheduleTimezone] = useState(() =>
    resolveBroadcastScheduleTimezone(),
  );
  const [broadcastImageError, setBroadcastImageError] = useState('');
  const [, setBroadcastScheduleEnabled] = useState(false);
  const [, setBroadcastScheduleDays] = useState(0);
  const [, setBroadcastScheduleTime] = useState(
    toLocalTimeInputValue(new Date(Date.now() + BROADCAST_HOUR_MS)),
  );
  const [broadcastScheduleError, setBroadcastScheduleError] = useState('');
  const [, setBroadcastCycleEnabled] = useState(false);
  const [, setBroadcastCycleEveryHours] = useState(MIN_BROADCAST_CYCLE_HOURS);
  const [, setBroadcastCycleCount] = useState(2);
  const [broadcastCycleError, setBroadcastCycleError] = useState('');
  const [broadcastPlannerResetKey, setBroadcastPlannerResetKey] = useState(0);
  const [broadcastPlannerState, setBroadcastPlannerState] =
    useState<BroadcastSchedulePlannerSelectionState>(EMPTY_BROADCAST_PLANNER_STATE);
  const [editingManagedBroadcast, setEditingManagedBroadcast] =
    useState<ManagedBroadcastDetails | null>(null);
  const [editingManagedAutopostRule, setEditingManagedAutopostRule] =
    useState<ManagedAutopostRuleDetails | null>(null);
  const [managedBroadcastDeleteTarget, setManagedBroadcastDeleteTarget] =
    useState<ManagedBroadcastListItem | null>(null);
  const [managedAutopostRuleDeleteTarget, setManagedAutopostRuleDeleteTarget] =
    useState<ManagedAutopostRuleSummary | null>(null);
  const [pendingBroadcastSlotConflict, setPendingBroadcastSlotConflict] = useState<{
    broadcastId: string | null;
    payload: SendBroadcastPayload;
  } | null>(null);
  const [pendingBroadcastPublishReview, setPendingBroadcastPublishReview] =
    useState<PendingBroadcastPublishReview | null>(null);
  const [broadcastWorkspaceView, setBroadcastWorkspaceView] =
    useState<BroadcastWorkspaceView>('compose');
  const [broadcastHistoryFilter, setBroadcastHistoryFilter] =
    useState<BroadcastHistoryFilter>('future');
  const [broadcastNowMs, setBroadcastNowMs] = useState(() => Date.now());
  const appliedBroadcastHandoffSignatureRef = useRef<string | null>(null);
  const appliedLegacyEditorTargetRef = useRef<string | null>(null);
  const broadcastDraftRestoreEpochRef = useRef(0);
  const [broadcastDraftRestoreReady, setBroadcastDraftRestoreReady] = useState(false);
  const searchParams = new URLSearchParams(location.search);
  const focusSection = searchParams.get('focus');
  const handoffRequested = searchParams.get('handoff') === '1';
  const legacyEditorTarget = resolveLegacyBroadcastEditorTarget(location.search);

  function applyBroadcastImages(nextImages: BroadcastImage[]) {
    const normalizedImages = normalizeBroadcastImageList(nextImages);
    const firstImage = normalizedImages[0];
    setBroadcastImages(normalizedImages);
    setBroadcastImagesPreparing(false);
    setBroadcastImageEnabled(normalizedImages.length > 0);
    setBroadcastImageBase64(firstImage?.base64 ?? '');
    setBroadcastImageMimeType(firstImage?.mimeType ?? '');
    setBroadcastImageFileName(firstImage?.fileName ?? '');
  }

  const settingsScreenQuery = useQuery({
    queryKey: queryKeys.channelSettingsScreen(chatId),
    queryFn: ({ signal }) =>
      getChannelSettingsScreen(api, chatId, { signal, prefetch: handoffRequested }),
    enabled: Boolean(chatId),
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    ...(handoffRequested
      ? {
          retry: (failureCount: number, error: unknown) =>
            shouldRetryTransientApiError(failureCount, error, 7),
          retryDelay: (failureCount: number) => Math.min(800 + failureCount * 400, 2600),
        }
      : {}),
  });
  const broadcastHandoffStateQuery = useQuery({
    queryKey: queryKeys.channelBroadcastHandoff(chatId),
    queryFn: () => getChannelBroadcastHandoffState(api, chatId ?? ''),
    enabled:
      Boolean(chatId) &&
      !editingManagedBroadcast &&
      focusSection === 'broadcast' &&
      handoffRequested,
    refetchOnWindowFocus: false,
  });
  const settingsHandoffMode = resolveBroadcastHandoffLoadMode({
    requested: Boolean(chatId) && focusSection === 'broadcast' && handoffRequested,
    queries: [settingsScreenQuery, broadcastHandoffStateQuery],
  });
  const settingsHandoffTerminalError = findTerminalSettingsLoadError(
    settingsScreenQuery.error,
    broadcastHandoffStateQuery.error,
  );
  const hasLegacyBroadcastHandoff =
    handoffRequested &&
    Boolean(
      broadcastHandoffStateQuery.data && hasBroadcastHandoffDraft(broadcastHandoffStateQuery.data),
    );
  const legacyBroadcastWorkspaceRequested =
    focusSection === 'broadcast' &&
    (hasLegacyBroadcastHandoff ||
      searchParams.get('workspace') === 'autoposts' ||
      legacyEditorTarget !== null);
  const sendBroadcastHandoffMutation = useMutation({
    mutationFn: (payload: SendBroadcastPayload) => sendChannelBroadcast(api, chatId ?? '', payload),
    onSuccess: async (result) => {
      const feedback = buildBroadcastSendFeedback(result);
      if (feedback.clearDraft) {
        resetBroadcastComposer();
      }
      let cleanupFailed = false;
      if (chatId) {
        const handoffQueryKey = queryKeys.channelBroadcastHandoff(chatId);
        if (feedback.clearDraft) {
          try {
            await clearChannelBroadcastHandoffState(api, chatId);
            await queryClient.invalidateQueries({ queryKey: handoffQueryKey });
          } catch {
            cleanupFailed = true;
            queryClient.setQueryData(handoffQueryKey, null);
          }
        }
        void queryClient.invalidateQueries({ queryKey: queryKeys.channelSettingsScreen(chatId) });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.channelManagedBroadcastCalendar(chatId),
        });
      }
      void queryClient.invalidateQueries({ queryKey: ['publications', 'legacy'] });
      pushToast({
        tone: cleanupFailed && feedback.tone === 'success' ? 'info' : feedback.tone,
        title: feedback.title,
        description:
          [
            feedback.description ?? '',
            cleanupFailed ? 'Черновик не удалось очистить. Не запускайте его повторно.' : '',
          ]
            .filter(Boolean)
            .join(' ') || undefined,
      });
      maxNotify(cleanupFailed ? 'warning' : feedback.notification);
    },
    onError: (error) => {
      const scheduleConflict = resolveBroadcastScheduleConflict(error);
      const description = normalizeApiError(error);
      if (scheduleConflict === 'target') {
        setBroadcastScheduleError('Занято у получателя.');
        void queryClient.invalidateQueries({ queryKey: queryKeys.channelSettingsScreen(chatId) });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.channelManagedBroadcastCalendar(chatId),
        });
      } else if (scheduleConflict === 'slot') {
        setBroadcastScheduleError('Занято.');
        void queryClient.invalidateQueries({ queryKey: queryKeys.channelSettingsScreen(chatId) });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.channelManagedBroadcastCalendar(chatId),
        });
      }
      pushToast({
        tone: 'danger',
        title: 'Не удалось запустить публикацию',
        description,
      });
      maxNotify('error');
    },
  });
  const broadcastComposerClientResetQuery = useQuery({
    queryKey: queryKeys.channelBroadcastComposerClientReset(chatId),
    queryFn: ({ signal }) =>
      getChannelBroadcastComposerClientResetState(api, chatId ?? '', { signal }),
    enabled: false,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (
      focusSection !== 'postSignature' &&
      focusSection !== 'broadcast' &&
      focusSection !== 'comments' &&
      focusSection !== 'giveaway' &&
      focusSection !== 'polls' &&
      focusSection !== 'postSuggestions'
    ) {
      return;
    }

    setExpandedSections((current) => ({
      ...current,
      ...(focusSection === 'postSignature'
        ? { postSignature: true }
        : focusSection === 'comments'
          ? { comments: true }
          : focusSection === 'postSuggestions'
            ? { postSuggestions: true }
            : focusSection === 'polls'
              ? { polls: true }
              : focusSection === 'giveaway'
                ? { giveaway: true }
                : { broadcast: true }),
    }));
  }, [focusSection]);

  const settingsQuery = {
    data: settingsScreenQuery.data?.settings,
    isLoading: settingsScreenQuery.isLoading,
    error: settingsScreenQuery.error,
    refetch: settingsScreenQuery.refetch,
  };
  const channelHeader = settingsScreenQuery.data?.header ?? null;
  const loadedPostSignature = settingsScreenQuery.data?.postSignature ?? null;
  const broadcastTargetContextLabel = channelHeader?.title?.trim() || 'Текущий канал';
  const managedBroadcasts = settingsScreenQuery.data?.managedBroadcasts ?? [];
  const broadcastCalendarQuery = useQuery({
    queryKey: queryKeys.channelManagedBroadcastCalendar(chatId),
    queryFn: () =>
      getChannelManagedBroadcastCalendar(api, chatId ?? '', {
        targetChatIds: chatId ? [chatId] : [],
      }),
    enabled: legacyBroadcastWorkspaceRequested && Boolean(chatId) && expandedSections.broadcast,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const managedAutopostRulesQuery = useQuery({
    queryKey: queryKeys.channelManagedAutopostRules(chatId),
    queryFn: () => getChannelManagedAutopostRules(api, chatId ?? ''),
    enabled: legacyBroadcastWorkspaceRequested && Boolean(chatId) && expandedSections.broadcast,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const orderedManagedAutopostRules = useMemo(
    () => sortManagedAutopostRules(managedAutopostRulesQuery.data ?? []),
    [managedAutopostRulesQuery.data],
  );
  const orderedManagedBroadcasts = useMemo(() => {
    const priority = (item: ManagedBroadcastListItem): number => {
      if (item.status === 'FAILED') {
        return 0;
      }
      if (item.status === 'PARTIAL') {
        return 1;
      }
      if (item.status === 'ACTIVE') {
        return 2;
      }
      if (item.status === 'COMPLETED') {
        return 3;
      }
      return 4;
    };

    const parseTimestamp = (value: string | null): number => {
      if (!value) {
        return Number.MAX_SAFE_INTEGER;
      }

      const parsed = new Date(value).getTime();
      return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
    };

    return [...managedBroadcasts].sort((left, right) => {
      const priorityDiff = priority(left) - priority(right);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }

      const nextSendDiff = parseTimestamp(left.nextSendAt) - parseTimestamp(right.nextSendAt);
      if (nextSendDiff !== 0) {
        return nextSendDiff;
      }

      return parseTimestamp(right.updatedAt) - parseTimestamp(left.updatedAt);
    });
  }, [managedBroadcasts]);
  const broadcastHistoryCounts = useMemo(
    () => countManagedBroadcastHistoryFilters(orderedManagedBroadcasts),
    [orderedManagedBroadcasts],
  );
  const filteredBroadcasts = useMemo(
    () => filterManagedBroadcastsByHistoryFilter(orderedManagedBroadcasts, broadcastHistoryFilter),
    [broadcastHistoryFilter, orderedManagedBroadcasts],
  );

  useEffect(() => {
    if (!settingsQuery.data) {
      return;
    }

    setDraft(settingsQuery.data);
    setSavedSnapshot(settingsQuery.data);
    setAutosaveState('idle');
    lastFailedDraftKeyRef.current = null;
  }, [settingsQuery.data]);

  useEffect(() => {
    if (!loadedPostSignature) {
      return;
    }
    const loadedKey = postSignatureSettingsKey(loadedPostSignature);
    const isNewChannel = postSignatureInitializedChatIdRef.current !== chatId;
    if (!isNewChannel && loadedKey === savedPostSignatureKeyRef.current) {
      return;
    }
    const canAdoptServerValue =
      postSignatureSaveInFlightRef.current?.chatId !== chatId &&
      latestPostSignatureKeyRef.current === savedPostSignatureKeyRef.current;
    if (!isNewChannel && !canAdoptServerValue) {
      return;
    }
    postSignatureInitializedChatIdRef.current = chatId;
    latestPostSignatureRef.current = loadedPostSignature;
    latestPostSignatureKeyRef.current = loadedKey;
    savedPostSignatureKeyRef.current = loadedKey;
    savedPostSignatureRef.current = loadedPostSignature;
    setPostSignatureDraft(loadedPostSignature);
    setSavedPostSignature(loadedPostSignature);
    setPostSignatureSaveState('idle');
  }, [chatId, loadedPostSignature]);

  useEffect(() => {
    if (!broadcastHandoffStateQuery.data || !handoffRequested) {
      return;
    }

    if (!hasBroadcastHandoffDraft(broadcastHandoffStateQuery.data)) {
      appliedBroadcastHandoffSignatureRef.current = null;
      return;
    }

    const signature = JSON.stringify(broadcastHandoffStateQuery.data);
    if (appliedBroadcastHandoffSignatureRef.current === signature) {
      return;
    }

    appliedBroadcastHandoffSignatureRef.current = signature;
    broadcastDraftRestoreEpochRef.current += 1;
    setEditingManagedBroadcast(null);
    setEditingManagedAutopostRule(null);
    setBroadcastButtons(broadcastHandoffStateQuery.data.buttons);
    const handoffSchedule = resolveBroadcastHandoffSchedule(broadcastHandoffStateQuery.data);
    setBroadcastTimingMode(handoffSchedule.timingMode);
    setBroadcastCycleDraft(handoffSchedule.cycle);
    setBroadcastScheduledSlots(handoffSchedule.scheduledSlots);
    setBroadcastScheduleTimezone(
      broadcastHandoffStateQuery.data.scheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
    );
    setBroadcastButtonErrors([]);
    setBroadcastScheduleError('');
    setBroadcastCycleError('');
    resetBroadcastPlanner();
    setBroadcastWorkspaceView('compose');
    setExpandedSections((current) => ({ ...current, broadcast: true }));
  }, [broadcastHandoffStateQuery.data, handoffRequested]);

  useEffect(() => {
    setBroadcastText('');
    setBroadcastTextError('');
    setBroadcastButtons([]);
    setBroadcastButtonsSheetOpen(false);
    setBroadcastButtonErrors([]);
    applyBroadcastImages([]);
    setBroadcastVideoCleared(false);
    setBroadcastTimingMode('now');
    setBroadcastCycleDraft(createDefaultBroadcastCycleDraft());
    setBroadcastScheduledSlots([]);
    setBroadcastScheduleTimezone(resolveBroadcastScheduleTimezone());
    setBroadcastImageError('');
    setBroadcastScheduleEnabled(false);
    setBroadcastScheduleDays(0);
    setBroadcastScheduleTime(toLocalTimeInputValue(new Date(Date.now() + BROADCAST_HOUR_MS)));
    setBroadcastScheduleError('');
    setBroadcastCycleEnabled(false);
    setBroadcastCycleEveryHours(MIN_BROADCAST_CYCLE_HOURS);
    setBroadcastCycleCount(2);
    setBroadcastCycleError('');
    setEditingManagedBroadcast(null);
    setEditingManagedAutopostRule(null);
    setBroadcastWorkspaceView('compose');
    setPendingBroadcastPublishReview(null);
    resetBroadcastPlanner();
    const restoreEpoch = ++broadcastDraftRestoreEpochRef.current;
    setBroadcastDraftRestoreReady(false);

    if (!chatId || !broadcastComposerClientResetQuery.isSuccess) {
      return;
    }

    const resetAt = broadcastComposerClientResetQuery.data?.resetAt;
    const shouldApplyReset =
      Boolean(resetAt) && !hasAppliedBroadcastComposerReset('channel', chatId, resetAt);
    let cancelled = false;
    const markRestoreReady = () => {
      if (cancelled || restoreEpoch !== broadcastDraftRestoreEpochRef.current) {
        return;
      }

      setBroadcastDraftRestoreReady(true);
    };

    if (shouldApplyReset && resetAt) {
      void (async () => {
        await clearBroadcastComposerDraft('channel', chatId);
        if (cancelled || restoreEpoch !== broadcastDraftRestoreEpochRef.current) {
          return;
        }

        markBroadcastComposerResetApplied('channel', chatId, resetAt);
        appliedBroadcastHandoffSignatureRef.current = null;
        resetBroadcastComposer();
        void queryClient.invalidateQueries({ queryKey: queryKeys.channelBroadcastHandoff(chatId) });
        markRestoreReady();
      })();

      return () => {
        cancelled = true;
      };
    }

    const applySavedBroadcastDraft = (savedBroadcastDraft: BroadcastComposerDraft) => {
      if (cancelled || restoreEpoch !== broadcastDraftRestoreEpochRef.current) {
        return;
      }
      setBroadcastText(savedBroadcastDraft.text);
      setBroadcastButtons(savedBroadcastDraft.buttons);
      setBroadcastTimingMode(savedBroadcastDraft.timingMode);
      setBroadcastCycleDraft(normalizeBroadcastCycleDraft(savedBroadcastDraft.cycle));
      setBroadcastScheduledSlots(sortAndUniqueBroadcastSlots(savedBroadcastDraft.scheduledSlots));
      setBroadcastScheduleTimezone(
        savedBroadcastDraft.scheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
      );
    };
    void loadBroadcastComposerDraftAsync('channel', chatId).then((draft) => {
      if (draft) {
        applySavedBroadcastDraft(draft);
      }
      markRestoreReady();
    });

    return () => {
      cancelled = true;
    };
  }, [
    broadcastComposerClientResetQuery.data?.resetAt,
    broadcastComposerClientResetQuery.isSuccess,
    chatId,
    queryClient,
  ]);

  useEffect(() => {
    if (
      !chatId ||
      editingManagedBroadcast ||
      editingManagedAutopostRule ||
      !broadcastDraftRestoreReady
    ) {
      return;
    }

    const draftToPersist: BroadcastComposerDraft = {
      text: broadcastText,
      targetMode: 'current',
      targetChatIds: chatId ? [chatId] : [],
      lastScopedTargetMode: 'current',
      buttons: broadcastButtons,
      imageEnabled: broadcastImageEnabled,
      imageBase64: broadcastImageBase64,
      imageMimeType: broadcastImageMimeType,
      imageFileName: broadcastImageFileName,
      images: broadcastImages,
      timingMode: broadcastTimingMode,
      scheduledSlots: broadcastScheduledSlots,
      scheduleTimezone: broadcastScheduleTimezone,
      cycle: broadcastCycleDraft,
    };

    saveBroadcastComposerDraft('channel', chatId, draftToPersist);
  }, [
    broadcastButtons,
    broadcastCycleDraft,
    broadcastDraftRestoreReady,
    broadcastImageBase64,
    broadcastImageEnabled,
    broadcastImageFileName,
    broadcastImageMimeType,
    broadcastImages,
    broadcastScheduleTimezone,
    broadcastScheduledSlots,
    broadcastText,
    broadcastTimingMode,
    chatId,
    editingManagedBroadcast,
    editingManagedAutopostRule,
  ]);

  useEffect(() => {
    const timerId = window.setInterval(() => {
      setBroadcastNowMs(Date.now());
    }, 60_000);

    return () => {
      window.clearInterval(timerId);
    };
  }, []);

  useEffect(() => {
    if (!chatId) {
      return;
    }

    saveLastEntityId('channel', chatId);
    if (routeChatTitle) {
      saveChatTitle(chatId, routeChatTitle);
    }
  }, [chatId, routeChatTitle]);

  const resolvedTitle = useMemo(() => {
    const fromHeader = channelHeader?.title?.trim();
    if (fromHeader) {
      return fromHeader;
    }

    if (routeChatTitle) {
      return routeChatTitle;
    }

    return readChatTitle(chatId);
  }, [channelHeader?.title, chatId, routeChatTitle]);

  useEffect(() => {
    if (!chatId || !resolvedTitle) {
      return;
    }

    saveChatTitle(chatId, resolvedTitle);
  }, [chatId, resolvedTitle]);

  const resolvedChannelLink = useMemo(() => {
    const fromHeader = channelHeader?.link?.trim() ?? '';
    if (isHttpUrl(fromHeader)) {
      return fromHeader;
    }

    if (routeChatLink) {
      return routeChatLink;
    }

    return '';
  }, [channelHeader?.link, routeChatLink]);

  function toggleSection(section: ChannelSettingsSectionKey) {
    if (expandedSections[section]) {
      closeSection(section);
      return;
    }

    startTransition(() => {
      setExpandedSections({
        ...INITIAL_EXPANDED_CHANNEL_SECTIONS,
        [section]: true,
      });
    });
  }

  function closeSection(section: ChannelSettingsSectionKey) {
    const legacyReturnPath = resolveLegacyPublicationReturnPath(location.state);
    if (section === 'broadcast' && legacyEditorTarget && legacyReturnPath) {
      navigate(-1);
      return;
    }
    if (
      (section === 'postSignature' && focusSection === 'postSignature') ||
      (section === 'broadcast' && focusSection === 'broadcast') ||
      (section === 'comments' && focusSection === 'comments') ||
      (section === 'postSuggestions' && focusSection === 'postSuggestions') ||
      (section === 'polls' && focusSection === 'polls') ||
      (section === 'giveaway' && focusSection === 'giveaway')
    ) {
      const nextSearchParams = new URLSearchParams(location.search);
      nextSearchParams.delete('focus');
      nextSearchParams.delete('handoff');
      nextSearchParams.delete('workspace');
      nextSearchParams.delete('legacyKind');
      nextSearchParams.delete('legacyId');
      navigate(
        {
          pathname: location.pathname,
          search: nextSearchParams.toString() ? `?${nextSearchParams.toString()}` : '',
        },
        { replace: true, state: location.state },
      );
    }

    setExpandedSections((current) =>
      current[section] ? INITIAL_EXPANDED_CHANNEL_SECTIONS : current,
    );
  }

  function requestPollsSectionClose() {
    if (pollWorkspaceRef.current) {
      pollWorkspaceRef.current.requestClose();
      return;
    }
    closeSection('polls');
  }

  function togglePollsSection() {
    if (expandedSections.polls) {
      requestPollsSectionClose();
      return;
    }
    toggleSection('polls');
  }

  function requestGiveawaySectionClose() {
    if (giveawayCardRef.current && !giveawayCardRef.current.requestClose()) {
      return;
    }
    closeSection('giveaway');
  }

  function toggleGiveawaySection() {
    if (expandedSections.giveaway) {
      requestGiveawaySectionClose();
      return;
    }
    toggleSection('giveaway');
  }

  const normalizedDraft = useMemo(
    () => (draft ? normalizeChannelSettingsDraft(draft, resolvedChannelLink) : null),
    [draft, resolvedChannelLink],
  );

  const normalizedSavedSnapshot = useMemo(
    () =>
      savedSnapshot ? normalizeChannelSettingsDraft(savedSnapshot, resolvedChannelLink) : null,
    [resolvedChannelLink, savedSnapshot],
  );

  const normalizedDraftKey = useMemo(
    () => (normalizedDraft ? channelSettingsDraftKey(normalizedDraft) : ''),
    [normalizedDraft],
  );

  const normalizedSavedSnapshotKey = useMemo(
    () => (normalizedSavedSnapshot ? channelSettingsDraftKey(normalizedSavedSnapshot) : ''),
    [normalizedSavedSnapshot],
  );

  const isDirty = useMemo(() => {
    if (!normalizedDraft || !normalizedSavedSnapshot) {
      return false;
    }

    return normalizedDraftKey !== normalizedSavedSnapshotKey;
  }, [normalizedDraft, normalizedDraftKey, normalizedSavedSnapshot, normalizedSavedSnapshotKey]);

  const isPostSignatureDirty = Boolean(
    postSignatureDraft &&
    savedPostSignature &&
    postSignatureSettingsKey(postSignatureDraft) !== postSignatureSettingsKey(savedPostSignature),
  );

  useEffect(() => {
    const shouldBlockClose =
      isDirty ||
      autosaveState === 'saving' ||
      isPostSignatureDirty ||
      customButtonEditorOpen ||
      postSignatureSaveState === 'saving';
    setMaxClosingConfirmation(shouldBlockClose);
    return () => {
      setMaxClosingConfirmation(false);
    };
  }, [
    autosaveState,
    isDirty,
    isPostSignatureDirty,
    customButtonEditorOpen,
    postSignatureSaveState,
  ]);

  function updatePostSignatureDraft(
    next: ChannelPostSignatureSettings,
  ): ChannelPostSignatureSettings {
    const normalized = normalizePostSignatureSettings(next);
    latestPostSignatureRef.current = normalized;
    latestPostSignatureKeyRef.current = postSignatureSettingsKey(normalized);
    setPostSignatureDraft(normalized);
    if (latestPostSignatureKeyRef.current === savedPostSignatureKeyRef.current) {
      setPostSignatureSaveState('idle');
    } else if (postSignatureSaveInFlightRef.current?.chatId !== chatId) {
      setPostSignatureSaveState('idle');
    }
    return normalized;
  }

  function persistLatestPostSignature(): Promise<void> {
    const currentOperation = postSignatureSaveInFlightRef.current;
    if (currentOperation?.chatId === chatId) {
      return currentOperation.promise;
    }

    const operationChatId = chatId;
    const operation = (async () => {
      while (
        activePostSignatureChatIdRef.current === operationChatId &&
        latestPostSignatureRef.current &&
        latestPostSignatureKeyRef.current !== savedPostSignatureKeyRef.current
      ) {
        // FLAG: The signature and general editor serialize their own writes so a
        // successful local save cannot make the other local draft stale.
        if (saveInFlightRef.current) await saveInFlightRef.current;
        if (activePostSignatureChatIdRef.current !== operationChatId) return;
        const validated = validatePostSignatureSettings(latestPostSignatureRef.current);
        if (!validated.success) {
          setPostSignatureSaveState('error');
          return;
        }
        const payload = validated.data;
        setPostSignatureSaveState('saving');
        setPostSignatureSaveError('');
        try {
          const saved = await updateChannelPostSignature(
            api,
            operationChatId,
            buildPostSignaturePatch(payload, savedPostSignatureRef.current),
          );
          const savedKey = postSignatureSettingsKey(saved);
          queryClient.setQueryData<ChannelSettingsScreenResponse>(
            queryKeys.channelSettingsScreen(operationChatId),
            (current) => (current ? { ...current, postSignature: saved } : current),
          );
          if (activePostSignatureChatIdRef.current !== operationChatId) {
            return;
          }
          // FLAG: Both editors share a settings row. Preserve unsaved field edits while
          // adopting the revision returned by this screen's confirmed write.
          setSavedSnapshot((current) =>
            current ? { ...current, revision: saved.revision } : current,
          );
          setDraft((current) => (current ? { ...current, revision: saved.revision } : current));
          if (latestNormalizedDraftRef.current)
            latestNormalizedDraftRef.current = {
              ...latestNormalizedDraftRef.current,
              revision: saved.revision,
            };
          savedPostSignatureKeyRef.current = savedKey;
          savedPostSignatureRef.current = saved;
          const reconciled = reconcilePostSignatureSave(
            payload,
            latestPostSignatureRef.current,
            saved,
          );
          latestPostSignatureRef.current = reconciled;
          latestPostSignatureKeyRef.current = postSignatureSettingsKey(reconciled);
          setSavedPostSignature(saved);
          setPostSignatureDraft(reconciled);
          setPostSignatureSaveState(
            latestPostSignatureKeyRef.current === savedKey ? 'saved' : 'saving',
          );
        } catch (error: unknown) {
          if (activePostSignatureChatIdRef.current !== operationChatId) {
            return;
          }
          let description = normalizeApiError(error);
          if (
            error instanceof ApiRequestError &&
            error.code === 'CHANNEL_SETTINGS_CONCURRENT_UPDATE'
          ) {
            try {
              const fresh = await getChannelPostSignature(api, operationChatId);
              if (activePostSignatureChatIdRef.current !== operationChatId) return;
              const reconciled = reconcilePostSignatureSave(
                savedPostSignatureRef.current ?? payload,
                latestPostSignatureRef.current ?? payload,
                fresh,
              );
              savedPostSignatureRef.current = fresh;
              savedPostSignatureKeyRef.current = postSignatureSettingsKey(fresh);
              latestPostSignatureRef.current = reconciled;
              latestPostSignatureKeyRef.current = postSignatureSettingsKey(reconciled);
              setSavedPostSignature(fresh);
              setPostSignatureDraft(reconciled);
              description =
                'Настройки изменились. Ваши правки сохранены в черновике. Проверьте их и сохраните снова.';
            } catch {
              // Keep the draft and its original revision until the server can be read.
            }
          }
          setPostSignatureSaveState('error');
          setPostSignatureSaveError(description);
          maxNotify('error');
          return;
        }
      }
    })();
    const trackedOperation = { chatId: operationChatId, promise: operation };
    void operation.finally(() => {
      if (postSignatureSaveInFlightRef.current === trackedOperation) {
        postSignatureSaveInFlightRef.current = null;
      }
    });

    postSignatureSaveInFlightRef.current = trackedOperation;
    return operation;
  }

  function savePostSignature(next: ChannelPostSignatureSettings): void {
    updatePostSignatureDraft(next);
    void persistLatestPostSignature();
  }

  const discardChannelSettingsChanges = () => {
    if (!savedSnapshot) {
      return;
    }

    setDraft(savedSnapshot);
    lastFailedDraftKeyRef.current = null;
    setAutosaveState('idle');
  };

  useEffect(() => {
    latestNormalizedDraftRef.current = normalizedDraft;
    latestDraftKeyRef.current = normalizedDraftKey;
    isDirtyRef.current = isDirty;
  }, [isDirty, normalizedDraft, normalizedDraftKey]);

  useEffect(() => {
    if (autosaveState === 'error' && normalizedDraftKey !== lastFailedDraftKeyRef.current) {
      setAutosaveState('idle');
      return;
    }

    if (autosaveState === 'saved' && isDirty) {
      setAutosaveState('idle');
    }
  }, [autosaveState, isDirty, normalizedDraftKey]);

  const saveCurrentDraft = async ({
    force = false,
  }: {
    force?: boolean;
  } = {}): Promise<ChannelSettings | null> => {
    if (postSignatureSaveInFlightRef.current?.chatId === chatId) {
      await postSignatureSaveInFlightRef.current.promise;
    }
    const payload = latestNormalizedDraftRef.current;
    const payloadKey = latestDraftKeyRef.current;

    if (!payload || (!force && !isDirtyRef.current)) {
      return null;
    }

    if (!force && payloadKey === lastFailedDraftKeyRef.current) {
      setAutosaveState('error');
      return null;
    }

    if (saveInFlightRef.current) {
      return saveInFlightRef.current;
    }

    setAutosaveState('saving');

    const request = updateChannelSettings(api, chatId, payload)
      .then((saved) => {
        lastFailedDraftKeyRef.current = null;
        setSavedSnapshot(saved);
        const signatureSaved = savedPostSignatureRef.current;
        const signatureDraft = latestPostSignatureRef.current;
        if (signatureSaved)
          savedPostSignatureRef.current = { ...signatureSaved, revision: saved.revision };
        if (signatureDraft)
          latestPostSignatureRef.current = { ...signatureDraft, revision: saved.revision };
        setSavedPostSignature((current) =>
          current ? { ...current, revision: saved.revision } : current,
        );
        setPostSignatureDraft((current) =>
          current ? { ...current, revision: saved.revision } : current,
        );
        setDraft((current) => {
          if (!current) {
            return current;
          }

          const currentNormalized = normalizeChannelSettingsDraft(current, resolvedChannelLink);
          return channelSettingsDraftKey(currentNormalized) === payloadKey
            ? saved
            : { ...current, revision: saved.revision };
        });
        setAutosaveState('saved');
        void queryClient.invalidateQueries({
          queryKey: ['publications', 'sources', 'channels'],
        });
        return saved;
      })
      .catch((error: unknown) => {
        lastFailedDraftKeyRef.current = payloadKey;
        setAutosaveState('error');
        maxNotify('error');
        throw error;
      })
      .finally(() => {
        saveInFlightRef.current = null;
      });

    saveInFlightRef.current = request;
    return request;
  };

  const saveChannelSettingsForBroadcast = async (): Promise<boolean> => {
    if (!isDirtyRef.current) {
      return true;
    }
    if (broadcastSettingsSaveInFlightRef.current) {
      return false;
    }

    broadcastSettingsSaveInFlightRef.current = true;
    setIsSavingChannelSettingsForBroadcast(true);
    try {
      return await saveUntilLatestDraftIsPersisted({
        getCurrentKey: () => latestDraftKeyRef.current,
        getSavedKey: (saved) =>
          channelSettingsDraftKey(normalizeChannelSettingsDraft(saved, resolvedChannelLink)),
        save: () => {
          const force = latestDraftKeyRef.current === lastFailedDraftKeyRef.current;
          return saveCurrentDraft({ force });
        },
      });
    } catch {
      return false;
    } finally {
      broadcastSettingsSaveInFlightRef.current = false;
      setIsSavingChannelSettingsForBroadcast(false);
    }
  };

  async function saveWorkspaceChanges(): Promise<boolean> {
    if (customButtonEditorOpen) return false;
    try {
      if (isDirty) {
        const saved = await saveCurrentDraft({ force: true });
        if (!saved) {
          return false;
        }
      }

      if (isPostSignatureDirty) {
        await persistLatestPostSignature();
        if (latestPostSignatureKeyRef.current !== savedPostSignatureKeyRef.current) {
          return false;
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  function discardWorkspaceChanges() {
    discardChannelSettingsChanges();
    if (savedPostSignature) {
      const savedKey = postSignatureSettingsKey(savedPostSignature);
      latestPostSignatureRef.current = savedPostSignature;
      latestPostSignatureKeyRef.current = savedKey;
      savedPostSignatureKeyRef.current = savedKey;
      setPostSignatureDraft(savedPostSignature);
      setPostSignatureSaveState('idle');
    }
  }

  useManagedEntityLeaveGuard({
    dirty: isDirty || isPostSignatureDirty || customButtonEditorOpen,
    saving: autosaveState === 'saving' || postSignatureSaveState === 'saving',
    save: saveWorkspaceChanges,
    discard: discardWorkspaceChanges,
  });

  const recheckAccessMutation = useMutation({
    mutationFn: () => recheckChannelManagedEntityAccess(api, chatId ?? ''),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.channelSettingsScreen(chatId) });
      pushToast({
        tone: 'success',
        title: 'Проверка доступа запущена',
      });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось запустить проверку доступа',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const sendBroadcastTestMutation = useMutation({
    mutationFn: (payload: SendBroadcastPayload) =>
      sendChannelBroadcastTest(api, chatId ?? '', payload),
    onSuccess: () => {
      pushToast({
        tone: 'success',
        title: 'Тест отправлен',
      });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Тест не отправлен',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const clearBroadcastHandoffMutation = useMutation({
    mutationFn: () => clearChannelBroadcastHandoffState(api, chatId ?? ''),
    onSuccess: () => {
      resetBroadcastComposer();
      void queryClient.invalidateQueries({ queryKey: queryKeys.channelBroadcastHandoff(chatId) });
      pushToast({
        tone: 'success',
        title: 'Черновик очищен',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось очистить черновик',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const invalidateChannelAutopostData = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.channelManagedAutopostRules(chatId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.channelSettingsScreen(chatId) });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.channelManagedBroadcastCalendar(chatId),
    });
  };

  const updateManagedAutopostRuleMutation = useMutation({
    mutationFn: ({
      ruleId,
      payload,
      status,
    }: {
      ruleId: string;
      payload?: SendBroadcastPayload;
      status?: 'ACTIVE' | 'PAUSED';
    }) =>
      updateChannelManagedAutopostRule(api, chatId ?? '', ruleId, {
        ...(payload
          ? {
              payload: normalizeManagedAutopostPayload(payload),
            }
          : {}),
        ...(status ? { status } : {}),
      }),
    onSuccess: (rule) => {
      invalidateChannelAutopostData();
      const savedEditingRule = editingManagedAutopostRule?.id === rule.id;
      if (savedEditingRule) {
        resetBroadcastComposer();
        setBroadcastWorkspaceView('autoposts');
      }
      pushToast({
        tone: rule.status === 'PAUSED' ? 'info' : 'success',
        title: savedEditingRule
          ? 'Автопост сохранён'
          : rule.status === 'PAUSED'
            ? 'Пауза'
            : 'Автопост запущен',
      });
      maxNotify(rule.status === 'PAUSED' ? 'warning' : 'success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось обновить автопост',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const deleteManagedAutopostRuleMutation = useMutation({
    mutationFn: (ruleId: string) => deleteChannelManagedAutopostRule(api, chatId ?? '', ruleId),
    onSuccess: () => {
      invalidateChannelAutopostData();
      if (deleteManagedAutopostRuleMutation.variables === editingManagedAutopostRule?.id) {
        resetBroadcastComposer();
      }
      setManagedAutopostRuleDeleteTarget(null);
      pushToast({ tone: 'info', title: 'Автопост отменён' });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось отменить автопост',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const updateManagedBroadcastMutation = useMutation({
    mutationFn: ({
      broadcastId,
      payload,
    }: {
      broadcastId: string;
      payload: SendBroadcastPayload;
    }) => updateChannelManagedBroadcast(api, chatId ?? '', broadcastId, payload),
    onSuccess: (broadcast) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.channelSettingsScreen(chatId) });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.channelManagedBroadcastCalendar(chatId),
      });
      resetBroadcastComposer();
      pushToast({
        tone: broadcast.status === 'FAILED' ? 'info' : 'success',
        title: 'Автопостинг обновлён',
        description: broadcast.nextSendAt
          ? `Следующая отправка: ${formatManagedBroadcastDateTime(
              broadcast.nextSendAt,
              broadcast.scheduleTimezone,
            )}.`
          : 'Изменения сохранены.',
      });
    },
    onError: (error) => {
      const scheduleConflict = resolveBroadcastScheduleConflict(error);
      const description = normalizeApiError(error);
      if (scheduleConflict === 'target') {
        setBroadcastScheduleError('Занято у получателя.');
        void queryClient.invalidateQueries({ queryKey: queryKeys.channelSettingsScreen(chatId) });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.channelManagedBroadcastCalendar(chatId),
        });
      } else if (scheduleConflict === 'slot') {
        setBroadcastScheduleError('Занято.');
        void queryClient.invalidateQueries({ queryKey: queryKeys.channelSettingsScreen(chatId) });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.channelManagedBroadcastCalendar(chatId),
        });
      }
      pushToast({
        tone: 'danger',
        title: 'Не удалось обновить автопостинг',
        description,
      });
      maxNotify('error');
    },
  });

  const cancelManagedBroadcastMutation = useMutation({
    mutationFn: (broadcastId: string) =>
      cancelChannelManagedBroadcast(api, chatId ?? '', broadcastId),
    onSuccess: (broadcast) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.channelSettingsScreen(chatId) });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.channelManagedBroadcastCalendar(chatId),
      });
      setManagedBroadcastDeleteTarget(null);
      if (editingManagedBroadcast?.id === broadcast.id) {
        resetBroadcastComposer();
      }
      pushToast({
        tone: 'info',
        title: 'Отправки отменены',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось отменить',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  const retryManagedBroadcastMutation = useMutation({
    mutationFn: (broadcastId: string) =>
      retryChannelManagedBroadcast(api, chatId ?? '', broadcastId),
    onSuccess: (broadcast) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.channelSettingsScreen(chatId) });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.channelManagedBroadcastCalendar(chatId),
      });
      pushToast({
        tone: broadcast.status === 'FAILED' || broadcast.status === 'PARTIAL' ? 'info' : 'success',
        title:
          broadcast.status === 'FAILED' || broadcast.status === 'PARTIAL'
            ? 'Часть чатов всё ещё с ошибкой'
            : 'Повтор выполнен',
        description: broadcast.nextSendAt
          ? `Следующая отправка: ${formatManagedBroadcastDateTime(
              broadcast.nextSendAt,
              broadcast.scheduleTimezone,
            )}.`
          : 'Ошибка закрыта.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось повторить автопостинг',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  function applyManagedBroadcastToComposer(broadcast: ManagedBroadcastDetails) {
    setEditingManagedAutopostRule(null);
    setEditingManagedBroadcast(broadcast);
    setBroadcastText(broadcast.text);
    setBroadcastButtons(broadcast.buttons);
    setBroadcastButtonErrors([]);
    applyBroadcastImages(resolveBroadcastImagesFromLegacyFields(broadcast));
    setBroadcastVideoCleared(false);
    const restoredTimingMode: BroadcastTimingMode =
      broadcast.scheduleMode === 'calendar'
        ? 'scheduled'
        : broadcast.cycleEnabled
          ? 'cycle'
          : broadcast.nextSendAt
            ? 'scheduled'
            : 'now';
    setBroadcastTimingMode(restoredTimingMode);
    setBroadcastCycleDraft(
      normalizeBroadcastCycleDraft({
        startMode: broadcast.nextSendAt ? 'later' : 'now',
        startAt: broadcast.nextSendAt ?? createDefaultBroadcastCycleDraft().startAt,
        everyHours: broadcast.cycleEveryHours,
        count: Math.max(2, broadcast.cycleCount),
      }),
    );
    setBroadcastScheduledSlots(
      sortAndUniqueBroadcastSlots(
        broadcast.scheduleMode === 'calendar'
          ? broadcast.scheduledSlots
          : broadcast.nextSendAt && !broadcast.cycleEnabled
            ? [broadcast.nextSendAt]
            : [],
      ),
    );
    setBroadcastScheduleTimezone(
      broadcast.scheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
    );
    setBroadcastTextError('');
    setBroadcastImageError('');
    setBroadcastScheduleError('');
    setBroadcastCycleError('');
    resetBroadcastPlanner();
    setExpandedSections((current) => ({ ...current, broadcast: true }));
  }

  const openManagedBroadcastEditorMutation = useMutation({
    mutationFn: (broadcastId: string) => getChannelManagedBroadcast(api, chatId ?? '', broadcastId),
    retry: (failureCount, error) => shouldRetryTransientApiError(failureCount, error, 2),
    onSuccess: (broadcast) => {
      applyManagedBroadcastToComposer(broadcast);
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось открыть автопостинг',
        description: normalizeApiError(error),
      });
      maxNotify('error');
    },
  });

  useEffect(() => {
    if (!legacyEditorTarget) {
      appliedLegacyEditorTargetRef.current = null;
      return;
    }

    const signature = `${chatId}:${legacyEditorTarget.kind}:${legacyEditorTarget.id}`;
    if (appliedLegacyEditorTargetRef.current === signature) {
      return;
    }

    if (legacyEditorTarget.kind === 'autopost') {
      appliedLegacyEditorTargetRef.current = signature;
      setBroadcastWorkspaceView('autoposts');
      return;
    }

    if (!settingsScreenQuery.data || openManagedBroadcastEditorMutation.isPending) {
      return;
    }

    appliedLegacyEditorTargetRef.current = signature;
    setBroadcastWorkspaceView('history');
    openManagedBroadcastEditorMutation.mutate(legacyEditorTarget.id);
  }, [chatId, legacyEditorTarget, openManagedBroadcastEditorMutation, settingsScreenQuery.data]);

  useEffect(() => {
    document.body.classList.add('channel-settings-page-open');

    return () => {
      document.body.classList.remove('channel-settings-page-open');
    };
  }, []);

  const showHeaderSaveRetry = autosaveState === 'error';
  const workspaceHeader = (
    <ManagedEntityWorkspaceHeader
      entityType="channel"
      screen="settings"
      title={resolvedTitle}
      avatarUrl={channelHeader ? (channelHeader.avatarUrl ?? null) : routeAvatarUrl}
      authoritativeIdentity={
        channelHeader
          ? {
              title: channelHeader.title,
              avatarUrl: channelHeader.avatarUrl ?? null,
            }
          : undefined
      }
      backTo={buildManagedEntitiesRoute('channel')}
      counterpartTo={
        chatId
          ? buildManagedEntityStatisticsRoute(
              'channel',
              chatId,
              readManagedEntityWorkspaceState(location.state)?.statsPreference,
            )
          : buildManagedEntitiesRoute('channel')
      }
      counterpartHidden={
        !chatId ||
        handoffRequested ||
        Boolean(settingsHandoffMode) ||
        legacyBroadcastWorkspaceRequested
      }
      compact={isHeaderCompact}
      busy={
        settingsQuery.isLoading || autosaveState === 'saving' || postSignatureSaveState === 'saving'
      }
      className="channel-settings-screen__sticky-header"
      identityAction={
        chatId &&
        channelHeader &&
        userId &&
        !handoffRequested &&
        !settingsHandoffMode &&
        !legacyBroadcastWorkspaceRequested ? (
          <Suspense fallback={null}>
            <LazyManagedEntityBotsControl
              api={api}
              userId={userId}
              entityType="channel"
              entityId={chatId}
              title={resolvedTitle}
            />
          </Suspense>
        ) : null
      }
      status={
        showHeaderSaveRetry ? (
          <div
            className="compact-page-header__actions"
            role="status"
            aria-live="assertive"
            aria-atomic="true"
          >
            <span className="compact-page-header__sr">Не удалось сохранить изменения.</span>
            <button
              type="button"
              className="compact-page-header__retry"
              onClick={() => {
                lastFailedDraftKeyRef.current = null;
                void saveCurrentDraft({ force: true });
              }}
              aria-label="Не удалось сохранить. Повторить"
              title="Повторить сохранение"
            >
              <IconoirSprite variant="iconoir" icon="RefreshDouble" aria-hidden focusable="false" />
            </button>
          </div>
        ) : null
      }
    />
  );

  if (!chatId) {
    return (
      <div className="page-stack page-enter" data-managed-entity-workspace="channel-settings">
        {workspaceHeader}
        <GlassCard>
          <StatusState
            tone="warning"
            title="Канал не выбран"
            description="Откройте канал из списка на главном экране."
            action={
              <Link to={buildManagedEntitiesRoute('channel')} className="button button--accent">
                К списку
              </Link>
            }
          />
        </GlassCard>
      </div>
    );
  }

  if (settingsHandoffMode === 'loading') {
    return (
      <div className="page-stack page-enter" data-managed-entity-workspace="channel-settings">
        {workspaceHeader}
        <Suspense fallback={null}>
          <LazySettingsHandoffState
            entityType="channel"
            mode="loading"
            retryCount={Math.max(
              settingsScreenQuery.failureCount,
              broadcastHandoffStateQuery.failureCount,
            )}
          />
        </Suspense>
      </div>
    );
  }

  if (settingsHandoffMode === 'error') {
    return (
      <div className="page-stack page-enter" data-managed-entity-workspace="channel-settings">
        {workspaceHeader}
        <Suspense fallback={null}>
          <LazySettingsHandoffState
            entityType="channel"
            mode="error"
            error={settingsHandoffTerminalError}
            onRetry={() => {
              void settingsQuery.refetch();
              void broadcastHandoffStateQuery.refetch();
            }}
          />
        </Suspense>
      </div>
    );
  }

  if (settingsQuery.isLoading) {
    return (
      <div className="page-stack page-enter" data-managed-entity-workspace="channel-settings">
        {workspaceHeader}
        <SettingsOverviewLoading desktopLines={6} />
      </div>
    );
  }

  if (settingsQuery.error) {
    return (
      <div className="page-stack page-enter" data-managed-entity-workspace="channel-settings">
        {workspaceHeader}
        <SettingsLoadErrorState
          entityType="channel"
          error={settingsQuery.error}
          onRetry={() => void settingsQuery.refetch()}
        />
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="page-stack page-enter" data-managed-entity-workspace="channel-settings">
        {workspaceHeader}
        <SettingsOverviewLoading desktopLines={6} />
      </div>
    );
  }

  const postSignature = postSignatureDraft ?? {
    enabled: false,
    presentation: 'signature' as const,
    text: CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
    url: '',
    customButtonsEnabled: false,
    customButtons: [],
  };
  const resolvedPostSignaturePreviewUrl = resolveChannelPostSignaturePreviewUrl(
    postSignature.url,
    resolvedChannelLink,
  );
  const fallbackPostSignatureUrl = parseChannelPostSignatureUrl(resolvedChannelLink).url;
  const postSignatureUrlError = resolvedPostSignaturePreviewUrl.error;
  const postSignatureValidation = validatePostSignatureSettings(postSignature);
  const postSignatureTextError = postSignatureValidation.success
    ? ''
    : (postSignatureValidation.error.issues.find((issue) => issue.path[0] === 'text')?.message ??
      '');

  function closePostSignatureSection() {
    if (customButtonEditorOpen) {
      runNativeBackHandlers();
      return;
    }
    closeSection('postSignature');
  }

  const normalizedBroadcastButtons = trimBroadcastLinkButtons(broadcastButtons);
  const broadcastSystemButtons = buildChannelBroadcastSystemButtons({
    commentsEnabled: draft.commentsEnabled,
    postSuggestionsEnabled: draft.postSuggestionsEnabled,
    postSuggestionsButtonText: draft.postSuggestionsButtonText,
    ctaButtonEnabled: postSignature.enabled && postSignature.presentation === 'button',
    ctaButtonText: postSignature.text,
  });
  const broadcastHasButton = normalizedBroadcastButtons.length > 0;
  const broadcastVisibleButtons = [...normalizedBroadcastButtons, ...broadcastSystemButtons];
  const broadcastHasVisibleButtons = broadcastVisibleButtons.length > 0;
  const broadcastVisibleButtonStatus = formatBroadcastButtonsStatus(broadcastVisibleButtons);
  const broadcastOccupiedSlots = managedBroadcasts
    .filter(
      (broadcast) =>
        broadcast.id !== editingManagedBroadcast?.id &&
        broadcast.autopostRuleId !== editingManagedAutopostRule?.id,
    )
    .flatMap((broadcast) => broadcast.scheduledSlots);
  const broadcastConflictOccupiedSlots =
    broadcastCalendarQuery.data?.slots && broadcastCalendarQuery.data.slots.length > 0
      ? sortAndUniqueBroadcastSlots(
          broadcastCalendarQuery.data.slots
            .filter(
              (slot) =>
                slot.hasTargetOverlap &&
                (!editingManagedBroadcast || slot.broadcastId !== editingManagedBroadcast.id) &&
                (!editingManagedAutopostRule ||
                  slot.autopostRuleId !== editingManagedAutopostRule.id),
            )
            .map((slot) => slot.scheduledAt),
        )
      : broadcastOccupiedSlots;
  const pendingBroadcastConflictSlots = pendingBroadcastSlotConflict
    ? findBroadcastSlotConflicts(
        pendingBroadcastSlotConflict.payload.scheduledSlots,
        broadcastConflictOccupiedSlots,
      )
    : [];
  const pendingBroadcastConflictPreviewSlot =
    pendingBroadcastConflictSlots[0] ??
    pendingBroadcastSlotConflict?.payload.scheduledSlots[0] ??
    null;
  const pendingBroadcastReviewPayload = pendingBroadcastPublishReview?.payload ?? null;
  const pendingBroadcastReviewFacts = pendingBroadcastReviewPayload
    ? [
        `Время · ${formatBroadcastPayloadScheduleLabel(pendingBroadcastReviewPayload)}`,
        pendingBroadcastReviewPayload.buttonEnabled || broadcastSystemButtons.length > 0
          ? `Кнопки · ${formatBroadcastButtonsPreview([
              ...pendingBroadcastReviewPayload.buttons,
              ...broadcastSystemButtons,
            ])}`
          : 'Кнопки · нет',
        pendingBroadcastReviewPayload.imageEnabled ||
        pendingBroadcastReviewPayload.mediaType === 'video'
          ? pendingBroadcastReviewPayload.images && pendingBroadcastReviewPayload.images.length > 1
            ? `${pendingBroadcastReviewPayload.images.length} фото`
            : 'Медиа'
          : null,
      ].filter((item): item is string => Boolean(item))
    : [];
  const isUpdatingManagedBroadcast = updateManagedBroadcastMutation.isPending;
  const isOpeningManagedBroadcastEditor = openManagedBroadcastEditorMutation.isPending;
  const isBroadcastBusy =
    isSavingChannelSettingsForBroadcast ||
    autosaveState === 'saving' ||
    sendBroadcastHandoffMutation.isPending ||
    sendBroadcastTestMutation.isPending ||
    clearBroadcastHandoffMutation.isPending ||
    updateManagedAutopostRuleMutation.isPending ||
    deleteManagedAutopostRuleMutation.isPending ||
    isOpeningManagedBroadcastEditor ||
    isUpdatingManagedBroadcast ||
    cancelManagedBroadcastMutation.isPending ||
    retryManagedBroadcastMutation.isPending;
  const broadcastSlotsLabel = formatChannelCountLabel(
    broadcastScheduledSlots.length,
    'отправка',
    'отправки',
    'отправок',
  );
  const normalizedBroadcastText = broadcastText.trim();
  const broadcastVideoSource = editingManagedBroadcast ?? editingManagedAutopostRule?.payload;
  const editingBroadcastHasVideo =
    !broadcastVideoCleared &&
    broadcastVideoSource?.mediaType === 'video' &&
    Boolean(broadcastVideoSource.mediaPayload);
  const broadcastImageLabel =
    broadcastImages.length > 1
      ? `${broadcastImages.length} фото`
      : broadcastImageEnabled
        ? 'Фото'
        : null;
  const broadcastHasDirectContent = Boolean(
    normalizedBroadcastText || broadcastImageEnabled || editingBroadcastHasVideo,
  );
  const broadcastImagesReady = !broadcastImageEnabled || areBroadcastImagesReady(broadcastImages);
  const broadcastMediaReady = broadcastImagesReady && !broadcastImagesPreparing;
  const broadcastHasPublishableContent = broadcastHasDirectContent;
  const broadcastContentReady = broadcastHasPublishableContent && broadcastMediaReady;
  const broadcastButtonDraftValid = !hasBroadcastLinkButtonErrors(
    validateBroadcastLinkButtons(normalizedBroadcastButtons),
  );
  const broadcastNormalizedCycle = normalizeBroadcastCycleDraft(
    broadcastCycleDraft,
    broadcastNowMs,
  );
  const broadcastCycleValidationError =
    broadcastTimingMode === 'cycle'
      ? getBroadcastCycleValidationError(broadcastNormalizedCycle, broadcastNowMs)
      : null;
  const broadcastTimingSummary =
    broadcastTimingMode === 'now'
      ? 'Сейчас'
      : broadcastTimingMode === 'cycle'
        ? formatBroadcastCycleSummary(broadcastNormalizedCycle, broadcastNowMs)
        : broadcastScheduledSlots.length > 0
          ? broadcastSlotsLabel
          : 'Без времени';
  const broadcastSelectionSummary = [
    broadcastPlannerState.selectedDayCount > 0
      ? formatChannelCountLabel(broadcastPlannerState.selectedDayCount, 'день', 'дня', 'дней')
      : null,
    broadcastPlannerState.futureSlotCount > 0
      ? formatChannelCountLabel(
          broadcastPlannerState.futureSlotCount,
          'отправка',
          'отправки',
          'отправок',
        )
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const broadcastPlannerPending = broadcastPlannerState.isDaySheetOpen;
  const broadcastHasFutureSlots =
    broadcastTimingMode === 'now' ||
    (broadcastTimingMode === 'cycle' && !broadcastCycleValidationError) ||
    (broadcastTimingMode === 'scheduled' &&
      broadcastPlannerState.futureSlotCount > 0 &&
      !broadcastPlannerState.hasBlockingIssue);
  const broadcastCalendarScheduleReady =
    broadcastTimingMode === 'scheduled' &&
    broadcastScheduledSlots.length > 0 &&
    broadcastPlannerState.futureSlotCount > 0 &&
    !broadcastPlannerPending &&
    !broadcastPlannerState.hasBlockingIssue;
  const broadcastScheduleReady =
    broadcastTimingMode === 'now' ||
    (broadcastTimingMode === 'cycle' && !broadcastCycleValidationError) ||
    broadcastCalendarScheduleReady;
  const broadcastTestReady = broadcastContentReady && broadcastButtonDraftValid;
  const broadcastSendDisabled =
    isBroadcastBusy ||
    !broadcastContentReady ||
    !broadcastScheduleReady ||
    !broadcastHasFutureSlots ||
    !broadcastButtonDraftValid;
  const broadcastAutopostDisabled =
    isBroadcastBusy ||
    !broadcastContentReady ||
    !broadcastCalendarScheduleReady ||
    !broadcastButtonDraftValid;
  const broadcastPublishIssueLabels = [
    !broadcastHasPublishableContent ? 'Текст' : null,
    broadcastHasPublishableContent && !broadcastMediaReady ? 'Фото' : null,
    !broadcastScheduleReady || !broadcastHasFutureSlots ? 'Время' : null,
    !broadcastButtonDraftValid ? 'Кнопки' : null,
  ].filter((item): item is string => Boolean(item));
  const broadcastPublishIssueActions = broadcastPublishIssueLabels.map((label) => ({
    label,
    onClick: () => {
      setBroadcastWorkspaceView('compose');

      if (label === 'Текст') {
        setBroadcastTextError('Добавьте текст, фото или видео.');
        return;
      }

      if (label === 'Фото') {
        setBroadcastImageError(
          broadcastImagesPreparing ? 'Фото ещё готовится.' : 'Фото не готово.',
        );
        return;
      }

      if (label === 'Время') {
        if (broadcastTimingMode === 'cycle') {
          setBroadcastCycleError(broadcastCycleValidationError ?? 'Проверьте цикл публикаций.');
          return;
        }

        setBroadcastScheduleError('Выберите время публикации.');
        return;
      }

      if (label === 'Кнопки') {
        setBroadcastButtonsSheetOpen(true);
      }
    },
  }));
  const showBroadcastResetAction =
    editingManagedBroadcast !== null ||
    broadcastTimingMode !== 'now' ||
    broadcastScheduledSlots.length > 0 ||
    normalizedBroadcastText.length > 0 ||
    broadcastImageEnabled ||
    broadcastHasButton;
  const broadcastHeaderSummary = broadcastTimingSummary;
  const commentsCardSummary = !draft.commentsEnabled
    ? 'Выкл'
    : draft.commentsModerationEnabled
      ? 'Модерация'
      : 'Без модерации';
  const commentsCardStatus = !draft.commentsEnabled
    ? 'Выкл'
    : draft.commentsModerationEnabled
      ? 'Модерация'
      : 'Вкл';
  const postSignatureLabel = postSignature.text.trim() || CHANNEL_POST_SIGNATURE_DEFAULT_TEXT;
  const postSignatureCardSummary = postSignature.enabled
    ? `${postSignature.presentation === 'button' ? 'Кнопка' : 'Ссылка'} · ${postSignatureLabel}`
    : 'Выключено';
  const postSignatureCardStatus =
    postSignatureSaveState === 'saving'
      ? 'Сохраняем'
      : postSignatureSaveState === 'error'
        ? 'Ошибка'
        : postSignature.enabled
          ? 'Вкл'
          : 'Выкл';
  const postSignatureTone =
    postSignatureSaveState === 'error' ? 'rose' : postSignature.enabled ? 'sky' : 'ink';

  const postSuggestionsEntryLabel =
    draft.postSuggestionsEntryMode === 'MINIAPP' ? 'Приложение' : 'Бот';
  const postSuggestionsCardSummary = draft.postSuggestionsEnabled
    ? `${postSuggestionsEntryLabel} · до ${draft.postSuggestionsDailyLimit} в сутки`
    : 'Выключено';
  const postSuggestionsCardStatus = draft.postSuggestionsEnabled
    ? postSuggestionsEntryLabel
    : 'Выкл';
  const broadcastCardStatus = editingManagedAutopostRule
    ? 'Правка'
    : broadcastTimingMode === 'cycle'
      ? 'Цикл'
      : broadcastTimingMode === 'now'
        ? 'Сейчас'
        : broadcastScheduledSlots.length > 0
          ? 'План'
          : broadcastHasVisibleButtons
            ? broadcastVisibleButtonStatus
            : broadcastHasPublishableContent
              ? 'Контент'
              : 'Пусто';
  const broadcastResetActionLabel = editingManagedBroadcast
    ? 'Сбросить изменения'
    : editingManagedAutopostRule
      ? 'Сбросить изменения'
      : 'Очистить автопостинг';
  const broadcastFooterScheduleLabel =
    broadcastTimingMode === 'now'
      ? 'Сейчас'
      : broadcastTimingMode === 'cycle'
        ? formatBroadcastCycleSummary(broadcastNormalizedCycle, broadcastNowMs)
        : broadcastSelectionSummary || broadcastSlotsLabel;
  const broadcastFooterTitle = [
    broadcastTargetContextLabel,
    broadcastFooterScheduleLabel,
    editingManagedBroadcast || editingManagedAutopostRule ? 'Правка' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const broadcastFooterMeta = [
    broadcastImageLabel,
    editingBroadcastHasVideo ? 'Видео' : null,
    broadcastHasVisibleButtons ? broadcastVisibleButtonStatus : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const broadcastPrimaryActionLabel = editingManagedBroadcast
    ? 'Сохранить'
    : editingManagedAutopostRule
      ? 'Сохранить'
      : broadcastTimingMode === 'now'
        ? 'Опубликовать'
        : broadcastTimingMode === 'scheduled'
          ? 'Запланировать публикацию'
          : 'Запустить';
  const broadcastFooterPrimaryActionLabel = editingManagedBroadcast
    ? 'Сохранить'
    : editingManagedAutopostRule
      ? 'Сохранить'
      : broadcastTimingMode === 'now'
        ? 'Опубликовать'
        : broadcastTimingMode === 'scheduled'
          ? 'Запланировать публикацию'
          : 'Запустить';
  const showBroadcastWorkspaceTabs = !editingManagedBroadcast && !editingManagedAutopostRule;
  const activeBroadcastWorkspaceView = showBroadcastWorkspaceTabs
    ? legacyBroadcastWorkspaceRequested &&
      !handoffRequested &&
      (broadcastWorkspaceView === 'compose' || broadcastWorkspaceView === 'calendar')
      ? legacyEditorTarget?.kind === 'broadcast'
        ? 'history'
        : 'autoposts'
      : broadcastWorkspaceView
    : 'compose';
  const broadcastDrilldownFooter = (
    <BroadcastPublishBar
      title={broadcastFooterTitle}
      meta={broadcastFooterMeta}
      issues={broadcastPublishIssueActions}
      busy={isBroadcastBusy}
      testLabel={sendBroadcastTestMutation.isPending ? 'Тест...' : 'Тест'}
      testAriaLabel={sendBroadcastTestMutation.isPending ? 'Отправляем тест' : 'Отправить тест'}
      testDisabled={isBroadcastBusy || !broadcastTestReady}
      primaryLabel={
        updateManagedAutopostRuleMutation.isPending && editingManagedAutopostRule
          ? 'Сохраняем...'
          : isUpdatingManagedBroadcast
            ? 'Сохраняем...'
            : isOpeningManagedBroadcastEditor
              ? 'Открываем...'
              : broadcastFooterPrimaryActionLabel
      }
      primaryDisabled={
        editingManagedAutopostRule ? broadcastAutopostDisabled : broadcastSendDisabled
      }
      onTest={handleSendChannelBroadcastTest}
      onPrimary={
        editingManagedAutopostRule ? handleSaveChannelAutopostRule : handleSendChannelBroadcast
      }
    />
  );

  function resetBroadcastPlanner() {
    setBroadcastPlannerState(EMPTY_BROADCAST_PLANNER_STATE);
    setBroadcastPlannerResetKey((current) => current + 1);
  }

  function resetBroadcastComposer() {
    setEditingManagedBroadcast(null);
    setEditingManagedAutopostRule(null);
    setBroadcastText('');
    setBroadcastTextError('');
    setBroadcastButtons([]);
    setBroadcastButtonsSheetOpen(false);
    setBroadcastButtonErrors([]);
    setBroadcastImageEnabled(false);
    setBroadcastImageBase64('');
    setBroadcastImageMimeType('');
    setBroadcastImageFileName('');
    setBroadcastImages([]);
    setBroadcastImagesPreparing(false);
    setBroadcastVideoCleared(false);
    setBroadcastTimingMode('now');
    setBroadcastCycleDraft(createDefaultBroadcastCycleDraft());
    setBroadcastScheduledSlots([]);
    setBroadcastScheduleTimezone(resolveBroadcastScheduleTimezone());
    setBroadcastImageError('');
    setBroadcastScheduleEnabled(false);
    setBroadcastScheduleDays(0);
    setBroadcastScheduleTime(toLocalTimeInputValue(new Date(Date.now() + BROADCAST_HOUR_MS)));
    setBroadcastScheduleError('');
    setBroadcastCycleEnabled(false);
    setBroadcastCycleEveryHours(MIN_BROADCAST_CYCLE_HOURS);
    setBroadcastCycleCount(2);
    setBroadcastCycleError('');
    setPendingBroadcastSlotConflict(null);
    setPendingBroadcastPublishReview(null);
    setBroadcastWorkspaceView('compose');
    resetBroadcastPlanner();
  }

  function handleCancelBroadcastEdit() {
    resetBroadcastComposer();
  }

  function handleClearBroadcastComposer() {
    if (editingManagedBroadcast || editingManagedAutopostRule) {
      handleCancelBroadcastEdit();
      return;
    }

    if (!chatId || clearBroadcastHandoffMutation.isPending) {
      resetBroadcastComposer();
      return;
    }

    clearBroadcastHandoffMutation.mutate();
  }

  function handleBroadcastPlannerStateChange(nextState: BroadcastSchedulePlannerSelectionState) {
    setBroadcastPlannerState((current) =>
      areBroadcastPlannerStatesEqual(current, nextState) ? current : nextState,
    );
  }

  function handleDeleteManagedBroadcast(broadcast: ManagedBroadcastListItem) {
    if (!chatId || cancelManagedBroadcastMutation.isPending) {
      return;
    }

    setManagedBroadcastDeleteTarget(broadcast);
  }

  function handleEditManagedBroadcast(broadcast: ManagedBroadcastListItem) {
    if (!chatId || openManagedBroadcastEditorMutation.isPending) {
      return;
    }

    openManagedBroadcastEditorMutation.mutate(broadcast.id);
  }

  function handleDeleteManagedBroadcastById(broadcastId: string) {
    const broadcast = managedBroadcasts.find((item) => item.id === broadcastId);
    if (!broadcast) {
      return;
    }

    handleDeleteManagedBroadcast(broadcast);
  }

  function handleEditManagedBroadcastById(broadcastId: string) {
    const broadcast = managedBroadcasts.find((item) => item.id === broadcastId);
    if (!broadcast) {
      return;
    }

    handleEditManagedBroadcast(broadcast);
  }

  function confirmDeleteManagedBroadcast() {
    if (!managedBroadcastDeleteTarget || !chatId || cancelManagedBroadcastMutation.isPending) {
      return;
    }

    cancelManagedBroadcastMutation.mutate(managedBroadcastDeleteTarget.id);
  }

  function handleDeleteManagedAutopostRule(rule: ManagedAutopostRuleSummary) {
    setManagedAutopostRuleDeleteTarget(rule);
  }

  function confirmDeleteManagedAutopostRule() {
    if (
      !managedAutopostRuleDeleteTarget ||
      !chatId ||
      deleteManagedAutopostRuleMutation.isPending
    ) {
      return;
    }

    deleteManagedAutopostRuleMutation.mutate(managedAutopostRuleDeleteTarget.id);
  }

  async function handleSaveChannelSection(section: ChannelSettingsSectionKey) {
    if (!isDirty) {
      closeSection(section);
      return;
    }

    try {
      const saved = await saveCurrentDraft({ force: true });
      if (saved) {
        closeSection(section);
      }
    } catch {
      // Error state is handled in saveCurrentDraft.
    }
  }

  function renderChannelSectionFooter(section: ChannelSettingsSectionKey) {
    if (!isDirty && autosaveState !== 'saving') {
      return null;
    }

    return (
      <div className="settings-drilldown__footer-actions is-single-action">
        <button
          type="button"
          className="button button--accent"
          onClick={() => void handleSaveChannelSection(section)}
          disabled={autosaveState === 'saving'}
          aria-live="polite"
        >
          {autosaveState === 'saving' ? 'Сохраняем...' : 'Сохранить'}
        </button>
      </div>
    );
  }

  function handleBroadcastButtonsEnabledChange(enabled: boolean) {
    if (enabled) {
      if (broadcastButtons.length === 0) {
        setBroadcastButtonRevealSignal((current) => current + 1);
      }
      setBroadcastButtons((current) =>
        current.length > 0 ? current : [createEmptyBroadcastLinkButton()],
      );
      return;
    }

    setBroadcastButtons([]);
    setBroadcastButtonErrors([]);
  }

  function validateBroadcastButtonDraft() {
    const nextErrors = validateBroadcastLinkButtons(normalizedBroadcastButtons);
    setBroadcastButtonErrors(nextErrors);
    return !hasBroadcastLinkButtonErrors(nextErrors);
  }

  function buildBroadcastPublishBasePayload(): BroadcastHandoffPayload {
    const scheduledSlots = sortAndUniqueBroadcastSlots(broadcastScheduledSlots);
    const buttonState = buildBroadcastLinkButtonLegacyFields(normalizedBroadcastButtons);
    const cycleDraft = normalizeBroadcastCycleDraft(broadcastCycleDraft);
    const isCalendarSchedule = broadcastTimingMode === 'scheduled';
    const isCycleSchedule = broadcastTimingMode === 'cycle';

    return {
      targetMode: 'current',
      targetChatIds: chatId ? [chatId] : [],
      applyToAllChats: false,
      buttons: buttonState.buttons,
      buttonEnabled: buttonState.buttonEnabled,
      buttonUrl: buttonState.buttonUrl,
      buttonText: buttonState.buttonText,
      scheduleMode: isCalendarSchedule ? 'calendar' : 'legacy',
      scheduleTimezone: broadcastScheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
      scheduledSlots: isCalendarSchedule ? scheduledSlots : [],
      sendAt: isCycleSchedule ? resolveBroadcastCycleSendAt(cycleDraft) : null,
      cycleEnabled: isCycleSchedule,
      cycleEveryHours: isCycleSchedule ? cycleDraft.everyHours : 1,
      cycleCount: isCycleSchedule ? cycleDraft.count : 1,
    };
  }

  function buildBroadcastTestPayload(): SendBroadcastPayload {
    const buttonState = buildBroadcastLinkButtonLegacyFields(normalizedBroadcastButtons);
    const videoSource = broadcastVideoSource;
    const keepVideoMedia =
      !broadcastVideoCleared &&
      !broadcastImageEnabled &&
      videoSource?.mediaType === 'video' &&
      videoSource.mediaPayload;

    return {
      text: normalizedBroadcastText,
      textFormat: 'markdown',
      targetMode: 'current',
      targetChatIds: chatId ? [chatId] : [],
      applyToAllChats: false,
      buttons: buttonState.buttons,
      buttonEnabled: buttonState.buttonEnabled,
      buttonUrl: buttonState.buttonUrl,
      buttonText: buttonState.buttonText,
      imageEnabled: broadcastImageEnabled,
      imageBase64: broadcastImageEnabled ? broadcastImageBase64 : '',
      imageMimeType: broadcastImageEnabled ? broadcastImageMimeType : '',
      imageFileName: broadcastImageEnabled ? broadcastImageFileName : '',
      images: broadcastImageEnabled ? broadcastImages : [],
      mediaType: keepVideoMedia ? 'video' : null,
      mediaPayload: keepVideoMedia ? (videoSource?.mediaPayload ?? null) : null,
      mediaMimeType: keepVideoMedia ? (videoSource?.mediaMimeType ?? '') : '',
      mediaFileName: keepVideoMedia ? (videoSource?.mediaFileName ?? '') : '',
      scheduleMode: 'legacy',
      scheduleTimezone: broadcastScheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
      scheduledSlots: [],
      sendAt: null,
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 1,
    };
  }

  function buildBroadcastPublishPayload(params: {
    keepVideoMedia: boolean;
    requestId?: string;
    videoSource: BroadcastVideoSource | null;
  }): SendBroadcastPayload {
    return {
      text: normalizedBroadcastText,
      textFormat: 'markdown',
      ...buildBroadcastPublishBasePayload(),
      ...(params.requestId ? { requestId: params.requestId } : {}),
      replaceConflictingSlots: false,
      imageEnabled: broadcastImageEnabled,
      imageBase64: broadcastImageEnabled ? broadcastImageBase64 : '',
      imageMimeType: broadcastImageEnabled ? broadcastImageMimeType : '',
      imageFileName: broadcastImageEnabled ? broadcastImageFileName : '',
      images: broadcastImageEnabled ? broadcastImages : [],
      mediaType: params.keepVideoMedia ? 'video' : null,
      mediaPayload: params.keepVideoMedia ? (params.videoSource?.mediaPayload ?? null) : null,
      mediaMimeType: params.keepVideoMedia ? (params.videoSource?.mediaMimeType ?? '') : '',
      mediaFileName: params.keepVideoMedia ? (params.videoSource?.mediaFileName ?? '') : '',
    };
  }

  function submitBroadcastPayload(broadcastId: string | null, payload: SendBroadcastPayload) {
    if (broadcastId) {
      updateManagedBroadcastMutation.mutate({
        broadcastId,
        payload,
      });
      return;
    }

    if (hasLegacyBroadcastHandoff) {
      sendBroadcastHandoffMutation.mutate(payload);
      return;
    }

    navigate('/publications');
  }

  function handleCloseBroadcastPublishReview() {
    if (!isBroadcastBusy) {
      setPendingBroadcastPublishReview(null);
    }
  }

  async function confirmBroadcastPublishReview() {
    if (!pendingBroadcastPublishReview || isBroadcastBusy) {
      return;
    }

    if (!(await saveChannelSettingsForBroadcast())) {
      return;
    }

    const { broadcastId, payload } = pendingBroadcastPublishReview;
    setPendingBroadcastPublishReview(null);

    const hasConflictingSlots =
      payload.scheduleMode === 'calendar' &&
      findBroadcastSlotConflicts(payload.scheduledSlots, broadcastConflictOccupiedSlots).length > 0;
    if (hasConflictingSlots) {
      setPendingBroadcastSlotConflict({ broadcastId, payload });
      return;
    }

    submitBroadcastPayload(broadcastId, payload);
  }

  function handleCloseBroadcastSlotConflict() {
    setPendingBroadcastSlotConflict(null);
    setBroadcastScheduleError('Занято.');
  }

  async function confirmBroadcastSlotReplacement() {
    if (!pendingBroadcastSlotConflict || isBroadcastBusy) {
      return;
    }

    if (!(await saveChannelSettingsForBroadcast())) {
      return;
    }

    const { broadcastId, payload } = pendingBroadcastSlotConflict;
    setPendingBroadcastSlotConflict(null);
    setBroadcastScheduleError('');
    submitBroadcastPayload(broadcastId, {
      ...payload,
      replaceConflictingSlots: true,
    });
  }

  async function handleSaveChannelAutopostRule() {
    if (!chatId || broadcastAutopostDisabled) {
      return;
    }

    if (!editingManagedAutopostRule) {
      if (!(await saveChannelSettingsForBroadcast())) {
        return;
      }
      navigate('/publications');
      return;
    }

    if (!(await saveChannelSettingsForBroadcast())) {
      return;
    }

    const payload = buildBroadcastPublishPayload({
      keepVideoMedia: editingBroadcastHasVideo,
      videoSource: editingManagedAutopostRule?.payload ?? null,
    });
    const nextPayload: SendBroadcastPayload = {
      ...payload,
      scheduleMode: 'calendar',
      scheduledSlots: sortAndUniqueBroadcastSlots(broadcastScheduledSlots),
      sendAt: null,
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 1,
    };

    updateManagedAutopostRuleMutation.mutate({
      ruleId: editingManagedAutopostRule.id,
      payload: nextPayload,
    });
  }

  async function handleSendChannelBroadcast() {
    if (!chatId) {
      return;
    }

    if (!editingManagedBroadcast && !hasLegacyBroadcastHandoff) {
      if (!(await saveChannelSettingsForBroadcast())) {
        return;
      }
      navigate('/publications');
      return;
    }

    const scheduledSlots = sortAndUniqueBroadcastSlots(broadcastScheduledSlots);
    const cycleDraft = normalizeBroadcastCycleDraft(broadcastCycleDraft);
    const cycleError =
      broadcastTimingMode === 'cycle'
        ? getBroadcastCycleValidationError(cycleDraft, Date.now())
        : null;
    setBroadcastScheduleError('');
    setBroadcastCycleError('');

    let hasError = false;
    const videoSource = broadcastVideoSource;
    const keepVideoMedia =
      !broadcastVideoCleared &&
      !broadcastImageEnabled &&
      videoSource?.mediaType === 'video' &&
      videoSource.mediaPayload;
    const broadcastImagesReady = areBroadcastImagesReady(broadcastImages);
    const hasDirectContent = Boolean(
      normalizedBroadcastText || broadcastImageEnabled || keepVideoMedia,
    );

    if (editingManagedBroadcast) {
      if (!hasDirectContent) {
        setBroadcastTextError('Добавьте текст, фото или видео.');
        hasError = true;
      } else if (normalizedBroadcastText.length > MAX_BROADCAST_TEXT_LENGTH) {
        setBroadcastTextError(`Максимум ${MAX_BROADCAST_TEXT_LENGTH} символов.`);
        hasError = true;
      } else {
        setBroadcastTextError('');
      }
    } else if (!hasDirectContent) {
      setBroadcastTextError('Добавьте текст, фото или видео.');
      hasError = true;
    } else if (normalizedBroadcastText.length > MAX_BROADCAST_TEXT_LENGTH) {
      setBroadcastTextError(`Максимум ${MAX_BROADCAST_TEXT_LENGTH} символов.`);
      hasError = true;
    } else {
      setBroadcastTextError('');
    }

    if (broadcastImageEnabled) {
      if (broadcastImagesPreparing) {
        setBroadcastImageError('Фото ещё готовится.');
        hasError = true;
      } else if (!broadcastImagesReady) {
        setBroadcastImageError('Фото не готово.');
        hasError = true;
      } else {
        setBroadcastImageError('');
      }
    } else {
      setBroadcastImageError('');
    }

    if (!validateBroadcastButtonDraft()) {
      hasError = true;
    }

    if (broadcastTimingMode === 'scheduled' && scheduledSlots.length === 0) {
      setBroadcastScheduleError('Добавьте время.');
      hasError = true;
    } else if (broadcastTimingMode === 'scheduled' && broadcastPlannerState.hasBlockingIssue) {
      setBroadcastScheduleError('Проверьте время.');
      hasError = true;
    } else if (broadcastTimingMode === 'scheduled' && broadcastPlannerState.futureSlotCount === 0) {
      setBroadcastScheduleError('Есть прошедшее время.');
      hasError = true;
    } else if (broadcastTimingMode === 'cycle' && cycleError) {
      setBroadcastCycleError(cycleError);
      hasError = true;
    } else {
      setBroadcastScheduleError('');
      setBroadcastCycleError('');
    }

    if (hasError) {
      return;
    }

    const payload = buildBroadcastPublishPayload({
      keepVideoMedia: Boolean(keepVideoMedia),
      videoSource: videoSource ?? null,
      requestId: createBroadcastRequestId(),
    });

    setPendingBroadcastPublishReview({
      broadcastId: editingManagedBroadcast?.id ?? null,
      payload,
    });
  }

  async function handleSendChannelBroadcastTest() {
    if (!chatId || isBroadcastBusy) {
      return;
    }

    const videoSource = broadcastVideoSource;
    const keepVideoMedia =
      !broadcastVideoCleared &&
      !broadcastImageEnabled &&
      videoSource?.mediaType === 'video' &&
      videoSource.mediaPayload;
    const broadcastImagesReady = areBroadcastImagesReady(broadcastImages);
    let hasError = false;

    if (!normalizedBroadcastText && !broadcastImageEnabled && !keepVideoMedia) {
      setBroadcastTextError('Добавьте текст, фото или видео.');
      hasError = true;
    } else if (normalizedBroadcastText.length > MAX_BROADCAST_TEXT_LENGTH) {
      setBroadcastTextError(`Максимум ${MAX_BROADCAST_TEXT_LENGTH} символов.`);
      hasError = true;
    } else {
      setBroadcastTextError('');
    }

    if (broadcastImageEnabled) {
      if (broadcastImagesPreparing) {
        setBroadcastImageError('Фото ещё готовится.');
        hasError = true;
      } else if (!broadcastImagesReady) {
        setBroadcastImageError('Фото не готово.');
        hasError = true;
      } else {
        setBroadcastImageError('');
      }
    } else {
      setBroadcastImageError('');
    }

    if (!validateBroadcastButtonDraft()) {
      hasError = true;
    }

    if (hasError) {
      return;
    }

    if (!(await saveChannelSettingsForBroadcast())) {
      return;
    }

    sendBroadcastTestMutation.mutate(buildBroadcastTestPayload());
  }

  function handleDesktopToggleRowClick(event: MouseEvent<HTMLElement>) {
    const switchLabel = resolveDesktopToggleRowLabel(event.target);
    if (!switchLabel) {
      return;
    }

    event.preventDefault();
    switchLabel.click();
  }

  return (
    <fieldset
      disabled={settingsScreenQuery.isFetching && !settingsScreenQuery.isFetchedAfterMount}
      style={{ margin: 0, padding: 0, border: 0, minWidth: 0 }}
      aria-label="Настройки канала"
      id="channel-settings-overview"
      className="channel-settings-screen page-enter"
      data-managed-entity-workspace="channel-settings"
      onClickCapture={handleDesktopToggleRowClick}
    >
      {workspaceHeader}

      {settingsScreenQuery.isFetching && !settingsScreenQuery.isFetchedAfterMount ? (
        <p role="status">Проверяем права. Сохранённые настройки уже доступны для просмотра.</p>
      ) : null}

      {channelHeader?.accessDiagnostics?.state === 'bot_access_lost' ? (
        <Suspense fallback={null}>
          <LazyManagedEntityAccessDiagnosticsBanner
            diagnostics={channelHeader.accessDiagnostics}
            entityLabel="канал"
            isRechecking={recheckAccessMutation.isPending}
            onRecheck={() => recheckAccessMutation.mutate()}
          />
        </Suspense>
      ) : null}

      <Suspense fallback={<SettingsOverviewSearchPlaceholder />}>
        <LazySettingsOverviewSearch
          key={chatId}
          containerId="channel-settings-overview"
          entrySelector=".channel-settings-card"
        />
      </Suspense>

      <SettingsOverviewGroups>
        <GlassCard
          className={cn(
            'channel-settings-card channel-post-signature-entry',
            postSignature.enabled && 'is-on',
            postSignatureSaveState === 'error' && 'is-error',
          )}
          elevated
        >
          <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
            <SettingsSectionToggle
              title={SHARED_CHANNEL_SECTION_PRESENTATIONS.postSignature.title}
              enabled={postSignature.enabled || postSignature.customButtonsEnabled}
              summary={postSignatureCardSummary}
              status={postSignatureCardStatus}
              icon={SHARED_CHANNEL_SECTION_PRESENTATIONS.postSignature.icon}
              tone={postSignatureTone}
              open={expandedSections.postSignature}
              controls="channel-settings-post-signature"
              onClick={() => toggleSection('postSignature')}
            />
          </div>

          <SettingsDrilldownPanel
            id="channel-settings-post-signature"
            icon={
              <SettingsSectionIcon name={SHARED_CHANNEL_SECTION_PRESENTATIONS.postSignature.icon} />
            }
            open={expandedSections.postSignature}
            title={SHARED_CHANNEL_SECTION_PRESENTATIONS.postSignature.title}
            tone={SHARED_CHANNEL_SECTION_PRESENTATIONS.postSignature.tone}
            className={SHARED_CHANNEL_SECTION_PRESENTATIONS.postSignature.panelClassName}
            onClose={closePostSignatureSection}
          >
            <div
              id="channel-settings-post-signature"
              className={cn(
                'settings-section__collapse channel-post-signature',
                expandedSections.postSignature && 'is-open',
                postSignature.enabled && 'is-on',
              )}
            >
              {expandedSections.postSignature ? (
                <div className="settings-section__collapse-inner channel-post-signature__panel-body">
                  <ChannelPostSignatureFields
                    key={chatId}
                    fields={createChannelSettingsFieldAdapter({
                      settings: postSignature,
                      baseline: savedPostSignature ?? postSignature,
                      readOnly: postSignatureSaveState === 'saving',
                      onChange: (next) => {
                        latestPostSignatureRef.current = next;
                        latestPostSignatureKeyRef.current = postSignatureSettingsKey(next);
                        setPostSignatureDraft(next);
                        if (postSignatureSaveInFlightRef.current?.chatId !== chatId)
                          setPostSignatureSaveState('idle');
                      },
                      errors: {
                        text: postSignatureTextError || undefined,
                        url: postSignatureUrlError || undefined,
                      },
                    })}
                    fallbackUrl={fallbackPostSignatureUrl}
                    onEditorOpen={setCustomButtonEditorOpen}
                    systemButtons={[
                      ...(draft.commentsEnabled ? ['💬 Комментарии'] : []),
                      ...(draft.postSuggestionsEnabled
                        ? [draft.postSuggestionsButtonText.trim() || '📰 Предложить пост']
                        : []),
                    ]}
                  />
                  <div className="channel-post-actions__save">
                    <span>Для новых публикаций</span>
                    <button
                      type="button"
                      className="button button--accent"
                      disabled={
                        !isPostSignatureDirty ||
                        customButtonEditorOpen ||
                        postSignatureSaveState === 'saving' ||
                        !postSignatureValidation.success
                      }
                      onClick={() => savePostSignature(postSignature)}
                    >
                      {postSignatureSaveState === 'saving' ? 'Сохраняем...' : 'Сохранить'}
                    </button>
                  </div>

                  {postSignatureSaveState === 'error' && postSignatureSaveError ? (
                    <p className="channel-post-actions__save-error" role="alert">
                      {postSignatureSaveError}
                    </p>
                  ) : null}
                  {postSignatureSaveState !== 'idle' || isPostSignatureDirty ? (
                    <div
                      className={cn(
                        'channel-post-signature__save-state',
                        postSignatureSaveState === 'saving' && 'is-saving',
                        postSignatureSaveState === 'error' && 'is-error',
                        postSignatureSaveState === 'idle' && isPostSignatureDirty && 'is-dirty',
                      )}
                      role="status"
                      aria-live="polite"
                    >
                      <span>
                        {postSignatureSaveState === 'saving'
                          ? 'Сохраняем...'
                          : postSignatureSaveState === 'error'
                            ? 'Не сохранено'
                            : isPostSignatureDirty
                              ? 'Изменено'
                              : 'Сохранено'}
                      </span>
                      {postSignatureSaveState === 'error' ? (
                        <button
                          type="button"
                          aria-label="Повторить сохранение действий"
                          title="Повторить"
                          onClick={() => savePostSignature(postSignature)}
                        >
                          <IconoirSprite variant="iconoir" icon="RefreshDouble" aria-hidden />
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </SettingsDrilldownPanel>
        </GlassCard>

        <GlassCard className="channel-settings-card" elevated>
          <div className="settings-section__head settings-section__head--interactive">
            <SettingsSectionToggle
              title={SHARED_CHANNEL_SECTION_PRESENTATIONS.quickButtons.title}
              enabled={draft.quickButtonsEnabled}
              summary="Кнопки из строк нового поста"
              status={draft.quickButtonsEnabled ? 'Вкл' : 'Выкл'}
              icon={SHARED_CHANNEL_SECTION_PRESENTATIONS.quickButtons.icon}
              tone={SHARED_CHANNEL_SECTION_PRESENTATIONS.quickButtons.tone}
              open={expandedSections.quickButtons}
              controls="channel-settings-quick-buttons"
              onClick={() => toggleSection('quickButtons')}
            />
          </div>
          <SettingsDrilldownPanel
            id="channel-settings-quick-buttons"
            icon={
              <SettingsSectionIcon name={SHARED_CHANNEL_SECTION_PRESENTATIONS.quickButtons.icon} />
            }
            open={expandedSections.quickButtons}
            title={SHARED_CHANNEL_SECTION_PRESENTATIONS.quickButtons.title}
            tone={SHARED_CHANNEL_SECTION_PRESENTATIONS.quickButtons.tone}
            onClose={() => toggleSection('quickButtons')}
            footer={renderChannelSectionFooter('quickButtons')}
            confirmCloseWhen={isDirty}
            onDiscardChanges={discardChannelSettingsChanges}
          >
            <ChannelQuickButtonsFields
              fields={createChannelSettingsFieldAdapter({
                settings: draft,
                onChange: (next) => setDraft(next),
              })}
            />
            {expandedSections.quickButtons && chatId && (
              <Suspense fallback={null}>
                <MarketplaceModuleToggle
                  api={api}
                  entityId={chatId}
                  entityType="channel"
                  profile="moderation"
                  module="CHANNEL_POST"
                />
              </Suspense>
            )}
          </SettingsDrilldownPanel>
        </GlassCard>

        <GlassCard className="channel-settings-card" elevated>
          <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
            <SettingsSectionToggle
              title={SHARED_CHANNEL_SECTION_PRESENTATIONS.comments.title}
              enabled={draft.commentsEnabled}
              summary={commentsCardSummary}
              status={commentsCardStatus}
              icon={SHARED_CHANNEL_SECTION_PRESENTATIONS.comments.icon}
              tone={SHARED_CHANNEL_SECTION_PRESENTATIONS.comments.tone}
              open={expandedSections.comments}
              controls="channel-settings-comments"
              onClick={() => toggleSection('comments')}
            />
          </div>

          <SettingsDrilldownPanel
            id="channel-settings-comments"
            icon={<SettingsSectionIcon name={SHARED_CHANNEL_SECTION_PRESENTATIONS.comments.icon} />}
            open={expandedSections.comments}
            title={SHARED_CHANNEL_SECTION_PRESENTATIONS.comments.title}
            summary={commentsCardSummary}
            tone={SHARED_CHANNEL_SECTION_PRESENTATIONS.comments.tone}
            className={SHARED_CHANNEL_SECTION_PRESENTATIONS.comments.panelClassName}
            onClose={() => toggleSection('comments')}
            footer={renderChannelSectionFooter('comments')}
            confirmCloseWhen={isDirty}
            onDiscardChanges={discardChannelSettingsChanges}
          >
            <div
              id="channel-settings-comments"
              className={cn('settings-section__collapse', expandedSections.comments && 'is-open')}
            >
              {expandedSections.comments ? (
                <div className="settings-section__collapse-inner">
                  <ChannelCommentsFields
                    fields={createChannelSettingsFieldAdapter({
                      settings: draft,
                      onChange: (next) => setDraft(next),
                    })}
                  />
                </div>
              ) : null}
            </div>
          </SettingsDrilldownPanel>
        </GlassCard>

        <GlassCard className="channel-settings-card" elevated>
          <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
            <SettingsSectionToggle
              title="Предложения"
              enabled={draft.postSuggestionsEnabled}
              summary={postSuggestionsCardSummary}
              status={postSuggestionsCardStatus}
              icon="spark"
              tone="mint"
              open={expandedSections.postSuggestions}
              controls="channel-settings-post-suggestions"
              onClick={() => toggleSection('postSuggestions')}
            />
          </div>

          <SettingsDrilldownPanel
            id="channel-settings-post-suggestions"
            icon={<SettingsSectionIcon name="spark" />}
            open={expandedSections.postSuggestions}
            title="Предложения"
            summary={postSuggestionsCardSummary}
            variant="screen"
            tone="mint"
            className="settings-drilldown__panel--notice settings-drilldown__panel--post-suggestions settings-drilldown__panel--post-suggestions-screen"
            overlayClassName="settings-drilldown--post-suggestions-screen"
            onClose={() => toggleSection('postSuggestions')}
            footer={renderChannelSectionFooter('postSuggestions')}
            confirmCloseWhen={isDirty}
            onDiscardChanges={discardChannelSettingsChanges}
          >
            <div
              id="channel-settings-post-suggestions"
              className={cn(
                'settings-section__collapse',
                expandedSections.postSuggestions && 'is-open',
              )}
            >
              {expandedSections.postSuggestions ? (
                <div className="settings-section__collapse-inner">
                  <ChannelPostSuggestionsFields
                    fields={createChannelSettingsFieldAdapter({
                      settings: draft,
                      onChange: (next) => setDraft(next),
                    })}
                  />
                </div>
              ) : null}
            </div>
          </SettingsDrilldownPanel>
        </GlassCard>

        {legacyBroadcastWorkspaceRequested ? (
          <GlassCard className="channel-settings-card" elevated>
            <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
              <SettingsSectionToggle
                title="Автопостинг"
                summary={broadcastHeaderSummary}
                status={broadcastCardStatus}
                icon="send"
                tone="sky"
                open={expandedSections.broadcast}
                controls="channel-settings-broadcast"
                onClick={() => toggleSection('broadcast')}
              />
            </div>

            <SettingsDrilldownPanel
              id="channel-settings-broadcast"
              open={expandedSections.broadcast}
              title="Автопостинг"
              summary={broadcastHeaderSummary}
              variant="screen"
              tone="sky"
              className="settings-drilldown__panel--campaign settings-drilldown__panel--broadcast settings-drilldown__panel--broadcast-screen"
              onClose={() => toggleSection('broadcast')}
              footer={activeBroadcastWorkspaceView === 'compose' ? broadcastDrilldownFooter : null}
            >
              <div
                id="channel-settings-broadcast"
                className={cn(
                  'settings-section__collapse',
                  expandedSections.broadcast && 'is-open',
                )}
              >
                {expandedSections.broadcast ? (
                  <div className="settings-section__collapse-inner">
                    <div className="channel-broadcast-studio broadcast-studio-screen broadcast-studio-screen--channel">
                      <div className="broadcast-studio-screen__chrome">
                        <BroadcastWorkspaceChrome
                          showTabs={showBroadcastWorkspaceTabs && !handoffRequested}
                          value={activeBroadcastWorkspaceView}
                          autopostCount={orderedManagedAutopostRules.length}
                          historyCount={orderedManagedBroadcasts.length}
                          compatibilityOnly
                          disabled={isBroadcastBusy}
                          showReset={showBroadcastResetAction}
                          resetLabel={broadcastResetActionLabel}
                          resetPending={clearBroadcastHandoffMutation.isPending}
                          onChange={setBroadcastWorkspaceView}
                          onReset={handleClearBroadcastComposer}
                        />
                      </div>

                      {activeBroadcastWorkspaceView === 'compose' ? (
                        <div className="broadcast-compose-flow broadcast-compose-flow--screen">
                          <div className="broadcast-stage-card broadcast-stage-card--message broadcast-stage-card--primary">
                            <div className="broadcast-stage-card__head">
                              <div className="broadcast-stage-card__title-wrap">
                                <strong>Сообщение</strong>
                              </div>
                              <span
                                className={cn(
                                  'broadcast-stage-card__status',
                                  broadcastContentReady ? 'is-ready' : 'is-pending',
                                )}
                              >
                                {broadcastContentReady
                                  ? 'Готов'
                                  : broadcastImagesPreparing
                                    ? 'Фото...'
                                    : broadcastHasDirectContent
                                      ? 'Проверка'
                                      : 'Пусто'}
                              </span>
                            </div>

                            <div className="broadcast-stage-card__body">
                              <Suspense fallback={null}>
                                <LazyBroadcastContentComposer
                                  text={broadcastText}
                                  maxLength={MAX_BROADCAST_TEXT_LENGTH}
                                  images={broadcastImages}
                                  videoLabel={editingBroadcastHasVideo ? 'Видео' : null}
                                  disabled={isBroadcastBusy}
                                  textError={broadcastTextError}
                                  imageError={broadcastImageError}
                                  onTextChange={(nextText) => {
                                    setBroadcastText(nextText);
                                    if (broadcastTextError) {
                                      setBroadcastTextError('');
                                    }
                                  }}
                                  onImagesChange={(nextImages) => {
                                    applyBroadcastImages(nextImages);
                                    if (nextImages.length > 0) {
                                      setBroadcastVideoCleared(true);
                                    }
                                    setBroadcastImageError('');
                                    if (broadcastTextError) {
                                      setBroadcastTextError('');
                                    }
                                  }}
                                  onImagePreparationChange={setBroadcastImagesPreparing}
                                  onClearVideo={() => {
                                    setBroadcastVideoCleared(true);
                                  }}
                                  onError={(message) => {
                                    setBroadcastImageError(message);
                                    pushToast({
                                      tone: 'danger',
                                      title: 'Фото не добавлено',
                                      description: message,
                                    });
                                    maxNotify('error');
                                  }}
                                  buttons={normalizedBroadcastButtons}
                                  systemButtons={broadcastSystemButtons}
                                  buttonsStatusLabel={broadcastVisibleButtonStatus}
                                  buttonsActive={broadcastHasVisibleButtons}
                                  buttonsError={!broadcastButtonDraftValid}
                                  onOpenButtons={() => setBroadcastButtonsSheetOpen(true)}
                                />
                              </Suspense>
                            </div>
                          </div>

                          <div className="broadcast-stage-card broadcast-stage-card--planner">
                            <div className="broadcast-stage-card__head">
                              <div className="broadcast-stage-card__title-wrap">
                                <strong>Когда</strong>
                              </div>
                            </div>

                            <div className="broadcast-stage-card__body">
                              <Suspense fallback={null}>
                                <LazyBroadcastSchedulePlanner
                                  resetKey={broadcastPlannerResetKey}
                                  value={broadcastScheduledSlots}
                                  occupiedSlots={broadcastOccupiedSlots}
                                  error={broadcastScheduleError || broadcastCycleError}
                                  disabled={isBroadcastBusy}
                                  managedBroadcasts={managedBroadcasts}
                                  calendarSlots={broadcastCalendarQuery.data?.slots ?? []}
                                  targetAwareAvailability
                                  sourceChatId={chatId}
                                  managedBroadcastsLoading={
                                    settingsScreenQuery.isLoading ||
                                    settingsScreenQuery.isFetching ||
                                    broadcastCalendarQuery.isFetching
                                  }
                                  currentTargetLabel={broadcastTargetContextLabel}
                                  targetContextLabel={broadcastTargetContextLabel}
                                  calendarRefreshing={broadcastCalendarQuery.isFetching}
                                  excludeBroadcastId={editingManagedBroadcast?.id ?? null}
                                  excludeAutopostRuleId={editingManagedAutopostRule?.id ?? null}
                                  onEditBroadcast={handleEditManagedBroadcastById}
                                  onDeleteBroadcast={handleDeleteManagedBroadcastById}
                                  pendingEditBroadcastId={
                                    openManagedBroadcastEditorMutation.isPending
                                      ? openManagedBroadcastEditorMutation.variables
                                      : null
                                  }
                                  pendingDeleteBroadcastId={
                                    cancelManagedBroadcastMutation.isPending
                                      ? cancelManagedBroadcastMutation.variables
                                      : null
                                  }
                                  timingMode={broadcastTimingMode}
                                  cycle={broadcastCycleDraft}
                                  onTimingModeChange={(nextMode) => {
                                    setBroadcastTimingMode(nextMode);
                                    setBroadcastScheduleError('');
                                    setBroadcastCycleError('');
                                  }}
                                  onCycleChange={(nextCycle) => {
                                    setBroadcastCycleDraft(nextCycle);
                                    setBroadcastCycleError('');
                                  }}
                                  onSelectionStateChange={handleBroadcastPlannerStateChange}
                                  onChange={(nextValue) => {
                                    setBroadcastScheduledSlots(nextValue);
                                    if (broadcastScheduleError) {
                                      setBroadcastScheduleError('');
                                    }
                                  }}
                                />
                              </Suspense>
                            </div>
                          </div>
                        </div>
                      ) : activeBroadcastWorkspaceView === 'calendar' ? (
                        <div className="broadcast-stage-card broadcast-stage-card--planner broadcast-stage-card--calendar">
                          <div className="broadcast-stage-card__head">
                            <div className="broadcast-stage-card__title-wrap">
                              <strong>Календарь</strong>
                            </div>
                          </div>

                          <div className="broadcast-stage-card__body">
                            <Suspense fallback={null}>
                              <LazyBroadcastSchedulePlanner
                                resetKey={`calendar-${broadcastPlannerResetKey}`}
                                value={[]}
                                occupiedSlots={broadcastOccupiedSlots}
                                disabled={isBroadcastBusy}
                                managedBroadcasts={managedBroadcasts}
                                calendarSlots={broadcastCalendarQuery.data?.slots ?? []}
                                sourceChatId={chatId}
                                managedBroadcastsLoading={
                                  settingsScreenQuery.isLoading ||
                                  settingsScreenQuery.isFetching ||
                                  broadcastCalendarQuery.isFetching
                                }
                                currentTargetLabel={broadcastTargetContextLabel}
                                targetContextLabel={broadcastTargetContextLabel}
                                calendarRefreshing={broadcastCalendarQuery.isFetching}
                                excludeBroadcastId={editingManagedBroadcast?.id ?? null}
                                excludeAutopostRuleId={editingManagedAutopostRule?.id ?? null}
                                onEditBroadcast={handleEditManagedBroadcastById}
                                onDeleteBroadcast={handleDeleteManagedBroadcastById}
                                pendingEditBroadcastId={
                                  openManagedBroadcastEditorMutation.isPending
                                    ? openManagedBroadcastEditorMutation.variables
                                    : null
                                }
                                pendingDeleteBroadcastId={
                                  cancelManagedBroadcastMutation.isPending
                                    ? cancelManagedBroadcastMutation.variables
                                    : null
                                }
                                viewMode="calendar"
                                onSelectionStateChange={handleBroadcastPlannerStateChange}
                                onChange={(nextValue) => {
                                  setBroadcastTimingMode('scheduled');
                                  setBroadcastScheduledSlots(nextValue);
                                  setBroadcastScheduleError('');
                                  setBroadcastWorkspaceView('compose');
                                }}
                              />
                            </Suspense>
                          </div>
                        </div>
                      ) : activeBroadcastWorkspaceView === 'autoposts' ? (
                        <div className="broadcast-stage-card broadcast-stage-card--feed">
                          <div className="broadcast-stage-card__head">
                            <div className="broadcast-stage-card__title-wrap">
                              <strong>Автопосты</strong>
                              <small>
                                {managedAutopostRulesQuery.isLoading
                                  ? 'Загрузка'
                                  : orderedManagedAutopostRules.length > 0
                                    ? `${orderedManagedAutopostRules.length} шт.`
                                    : 'Пусто'}
                              </small>
                            </div>
                          </div>

                          <div className="broadcast-stage-card__body">
                            <div className="managed-broadcasts-list">
                              {orderedManagedAutopostRules.length === 0 &&
                              !managedAutopostRulesQuery.isLoading ? (
                                <div className="managed-broadcasts-list__empty">
                                  Автопостов пока нет. Соберите сообщение и сохраните автопост.
                                </div>
                              ) : null}

                              <Suspense fallback={<SkeletonCard lines={2} />}>
                                {orderedManagedAutopostRules.map((rule) => (
                                  <LazyManagedAutopostRuleCard
                                    key={rule.id}
                                    rule={rule}
                                    nextLabel={formatCompactManagedBroadcastDateTime(
                                      rule.nextSendAt,
                                      rule.scheduleTimezone,
                                    )}
                                    facts={buildManagedAutopostRuleFacts(rule, 'Текущий канал')}
                                    isBusy={isBroadcastBusy}
                                    onPause={() =>
                                      updateManagedAutopostRuleMutation.mutate({
                                        ruleId: rule.id,
                                        status: 'PAUSED',
                                      })
                                    }
                                    onDelete={() => handleDeleteManagedAutopostRule(rule)}
                                  />
                                ))}
                              </Suspense>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="broadcast-stage-card broadcast-stage-card--feed">
                          <div className="broadcast-stage-card__head">
                            <div className="broadcast-stage-card__title-wrap">
                              <strong>История</strong>
                              <small>
                                {settingsScreenQuery.isLoading
                                  ? 'Загрузка'
                                  : filteredBroadcasts.length > 0
                                    ? `${filteredBroadcasts.length} записей`
                                    : 'Пусто'}
                              </small>
                            </div>
                          </div>

                          <div className="broadcast-stage-card__body">
                            <BroadcastHistoryFilterTabs
                              value={broadcastHistoryFilter}
                              counts={broadcastHistoryCounts}
                              onChange={setBroadcastHistoryFilter}
                            />

                            <div className="managed-broadcasts-list">
                              {filteredBroadcasts.length === 0 && !settingsScreenQuery.isLoading ? (
                                <div className="managed-broadcasts-list__empty">
                                  История пока пустая.
                                </div>
                              ) : null}

                              <Suspense fallback={<SkeletonCard lines={2} />}>
                                {filteredBroadcasts.map((broadcast) => {
                                  const cardTone = resolveManagedBroadcastCardTone(broadcast);
                                  const cardMetric = resolveManagedBroadcastMetric(
                                    broadcast,
                                    broadcastNowMs,
                                  );
                                  const cardFacts = buildManagedBroadcastFactChips(broadcast);
                                  const canEditBroadcastSchedule =
                                    broadcast.scheduleMode === 'calendar' &&
                                    broadcast.status !== 'COMPLETED' &&
                                    broadcast.status !== 'CANCELED';
                                  const canCancelBroadcast =
                                    broadcast.status !== 'COMPLETED' &&
                                    broadcast.status !== 'CANCELED';
                                  const isDeletingBroadcast =
                                    cancelManagedBroadcastMutation.isPending &&
                                    cancelManagedBroadcastMutation.variables === broadcast.id;
                                  const isOpeningBroadcastEditor =
                                    openManagedBroadcastEditorMutation.isPending &&
                                    openManagedBroadcastEditorMutation.variables === broadcast.id;
                                  const isRetryingBroadcast =
                                    retryManagedBroadcastMutation.isPending &&
                                    retryManagedBroadcastMutation.variables === broadcast.id;
                                  const cardBadge = isOpeningBroadcastEditor
                                    ? 'Открываем'
                                    : resolveManagedBroadcastCardBadge(broadcast);

                                  return (
                                    <LazyManagedBroadcastHistoryCard
                                      key={broadcast.id}
                                      broadcast={broadcast}
                                      tone={cardTone}
                                      badge={cardBadge}
                                      title={resolveManagedBroadcastCardTitle(broadcast)}
                                      metric={cardMetric}
                                      facts={cardFacts}
                                      canEdit={canEditBroadcastSchedule}
                                      canCancel={canCancelBroadcast}
                                      isBusy={isBroadcastBusy}
                                      isDeleting={isDeletingBroadcast}
                                      isRetrying={isRetryingBroadcast}
                                      onEdit={() => handleEditManagedBroadcast(broadcast)}
                                      onRetry={() =>
                                        retryManagedBroadcastMutation.mutate(broadcast.id)
                                      }
                                      onDelete={() => handleDeleteManagedBroadcast(broadcast)}
                                    />
                                  );
                                })}
                              </Suspense>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            </SettingsDrilldownPanel>
          </GlassCard>
        ) : null}

        {chatId ? (
          <GlassCard className="channel-settings-card" elevated>
            <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
              <SettingsSectionToggle
                title="Опросы"
                summary="Создание, публикация и результаты"
                status="Голоса"
                icon={
                  <IconoirSprite
                    variant="iconoir"
                    icon="StatsUpSquare"
                    aria-hidden
                    focusable="false"
                  />
                }
                tone="mint"
                open={expandedSections.polls}
                controls="channel-settings-polls"
                onClick={togglePollsSection}
              />
            </div>

            <SettingsDrilldownPanel
              id="channel-settings-polls"
              icon={
                <IconoirSprite
                  variant="iconoir"
                  icon="StatsUpSquare"
                  aria-hidden
                  focusable="false"
                />
              }
              open={expandedSections.polls}
              title="Опросы"
              variant="screen"
              tone="mint"
              className="settings-drilldown__panel--campaign settings-drilldown__panel--polls"
              onClose={requestPollsSectionClose}
            >
              <div
                id="channel-settings-polls-collapse"
                className={cn('settings-section__collapse', expandedSections.polls && 'is-open')}
              >
                {expandedSections.polls ? (
                  <div className="settings-section__collapse-inner">
                    <Suspense fallback={<SkeletonCard lines={4} />}>
                      <LazyManagedPollWorkspace
                        key={`channel:${chatId}`}
                        ref={pollWorkspaceRef}
                        api={api}
                        entityType="channel"
                        entityId={chatId}
                        onClosePanel={() => closeSection('polls')}
                      />
                    </Suspense>
                  </div>
                ) : null}
              </div>
            </SettingsDrilldownPanel>
          </GlassCard>
        ) : null}

        {chatId ? (
          <GlassCard className="channel-settings-card" elevated>
            <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
              <SettingsSectionToggle
                title="Розыгрыши"
                summary="Запуск, участники и итоги"
                status=""
                icon="gift"
                tone="amber"
                open={expandedSections.giveaway}
                controls="channel-settings-giveaway"
                onClick={toggleGiveawaySection}
              />
            </div>

            <SettingsDrilldownPanel
              id="channel-settings-giveaway"
              icon={<SettingsSectionIcon name="gift" />}
              open={expandedSections.giveaway}
              title="Розыгрыши"
              summary="Запуск и итоги"
              tone="amber"
              className="settings-drilldown__panel--campaign settings-drilldown__panel--giveaway settings-drilldown__panel--channel-giveaway"
              onClose={requestGiveawaySectionClose}
            >
              <div
                id="channel-settings-giveaway"
                className={cn('settings-section__collapse', expandedSections.giveaway && 'is-open')}
              >
                {expandedSections.giveaway ? (
                  <div className="settings-section__collapse-inner">
                    <Suspense fallback={<SkeletonCard lines={4} />}>
                      <LazyManagedGiveawayCard
                        ref={giveawayCardRef}
                        api={api}
                        entityType="channel"
                        entityId={chatId}
                        onClosePanel={() => closeSection('giveaway')}
                      />
                    </Suspense>
                  </div>
                ) : null}
              </div>
            </SettingsDrilldownPanel>
          </GlassCard>
        ) : null}
        <MarketplaceProfileCard
          api={api}
          entityTitle={resolvedTitle}
          entityAvatarUrl={channelHeader ? (channelHeader.avatarUrl ?? null) : routeAvatarUrl}
          entityId={chatId ?? ''}
          entityType="channel"
          profile="moderation"
        />
      </SettingsOverviewGroups>

      <Suspense fallback={null}>
        <LazyBroadcastButtonsSheet
          open={broadcastButtonsSheetOpen}
          api={api}
          enabled={broadcastHasButton}
          buttons={broadcastButtons}
          errors={broadcastButtonErrors}
          revealNextStepSignal={broadcastButtonRevealSignal}
          contextEntityType="channel"
          disabled={isBroadcastBusy}
          urlPlaceholder="https://max.ru/channel/..."
          textPlaceholder="Открыть"
          onEnabledChange={handleBroadcastButtonsEnabledChange}
          onChange={(nextButtons) => {
            setBroadcastButtons(nextButtons);
            if (broadcastButtonErrors.length > 0) {
              setBroadcastButtonErrors([]);
            }
          }}
          onClose={() => setBroadcastButtonsSheetOpen(false)}
        />
      </Suspense>

      <Suspense fallback={null}>
        <LazyBroadcastPublishReviewSheet
          id="channel-broadcast-publish-review"
          open={pendingBroadcastPublishReview !== null}
          text={pendingBroadcastReviewPayload?.text ?? ''}
          hasMedia={Boolean(
            pendingBroadcastReviewPayload?.imageEnabled ||
            pendingBroadcastReviewPayload?.mediaType === 'video',
          )}
          facts={pendingBroadcastReviewFacts}
          confirmLabel={broadcastPrimaryActionLabel}
          confirmBusyLabel={
            isSavingChannelSettingsForBroadcast
              ? 'Сохраняем настройки...'
              : updateManagedBroadcastMutation.isPending
                ? 'Сохраняем...'
                : sendBroadcastHandoffMutation.isPending
                  ? broadcastTimingMode === 'now'
                    ? 'Публикуем...'
                    : 'Планируем...'
                  : '...'
          }
          isBusy={isBroadcastBusy}
          extraActionBusy={sendBroadcastTestMutation.isPending}
          extraActionDisabled={!broadcastTestReady}
          onExtraAction={handleSendChannelBroadcastTest}
          onClose={handleCloseBroadcastPublishReview}
          onConfirm={confirmBroadcastPublishReview}
        />
      </Suspense>

      <ActionConfirmSheet
        id="channel-broadcast-slot-conflict"
        open={pendingBroadcastSlotConflict !== null}
        title="Время занято"
        summary="Можно заменить только эту отправку."
        previewTitle={
          pendingBroadcastConflictPreviewSlot
            ? formatCompactManagedBroadcastDateTime(
                pendingBroadcastConflictPreviewSlot,
                pendingBroadcastSlotConflict?.payload.scheduleTimezone,
              )
            : 'Занято'
        }
        previewMeta={
          pendingBroadcastConflictSlots.length > 1
            ? formatChannelCountLabel(
                pendingBroadcastConflictSlots.length,
                'занятая отправка',
                'занятые отправки',
                'занятых отправок',
              )
            : 'Заменим, если получатели свободны.'
        }
        confirmLabel="Заменить"
        cancelLabel="Другое время"
        tone="accent"
        onClose={handleCloseBroadcastSlotConflict}
        onConfirm={confirmBroadcastSlotReplacement}
      />

      <ActionConfirmSheet
        id="channel-managed-broadcast-delete"
        open={managedBroadcastDeleteTarget !== null}
        title="Отменить отправки?"
        previewTitle={
          managedBroadcastDeleteTarget ? (
            <MaxMarkdownPreview
              value={managedBroadcastDeleteTarget.textPreview}
              className="action-confirm-sheet__preview-markdown max-markdown-preview--clamp-2"
              normalizeWhitespace
              fallback={managedBroadcastDeleteTarget.hasImage ? 'Фото без текста' : null}
            />
          ) : undefined
        }
        previewMeta={
          managedBroadcastDeleteTarget
            ? managedBroadcastDeleteTarget.nextSendAt
              ? `Следующая отправка · ${formatCompactManagedBroadcastDateTime(
                  managedBroadcastDeleteTarget.nextSendAt,
                  managedBroadcastDeleteTarget.scheduleTimezone,
                )}`
              : 'Будущие отправки будут сняты.'
            : undefined
        }
        confirmLabel="Отменить"
        confirmBusyLabel="Отменяем..."
        tone="danger"
        isBusy={cancelManagedBroadcastMutation.isPending}
        onClose={() => setManagedBroadcastDeleteTarget(null)}
        onConfirm={confirmDeleteManagedBroadcast}
      />

      <ActionConfirmSheet
        id="channel-managed-autopost-rule-delete"
        open={managedAutopostRuleDeleteTarget !== null}
        title="Отменить автопост?"
        previewTitle={
          managedAutopostRuleDeleteTarget ? (
            <MaxMarkdownPreview
              value={managedAutopostRuleDeleteTarget.textPreview}
              className="action-confirm-sheet__preview-markdown max-markdown-preview--clamp-2"
              normalizeWhitespace
              fallback={
                managedAutopostRuleDeleteTarget.hasVideo
                  ? 'Видео без текста'
                  : managedAutopostRuleDeleteTarget.hasImage
                    ? 'Фото без текста'
                    : 'Пусто'
              }
            />
          ) : undefined
        }
        previewMeta={
          managedAutopostRuleDeleteTarget?.nextSendAt
            ? `Следующий · ${formatCompactManagedBroadcastDateTime(
                managedAutopostRuleDeleteTarget.nextSendAt,
                managedAutopostRuleDeleteTarget.scheduleTimezone,
              )}`
            : undefined
        }
        confirmLabel="Отменить"
        confirmBusyLabel="Отменяем..."
        tone="danger"
        isBusy={deleteManagedAutopostRuleMutation.isPending}
        onClose={() => setManagedAutopostRuleDeleteTarget(null)}
        onConfirm={confirmDeleteManagedAutopostRule}
      />
    </fieldset>
  );
}
