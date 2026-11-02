import { AppIcon as IconoirSprite } from '../components/ui/app-icon';
import { useExpandedText } from '../lib/use-expanded-text';
import { isMaxMemberRestoreAvailable } from '@maxim/contracts/max-capabilities';
import type {
  LogsDashboardRange,
  LogsDashboardResponse,
  LogsDashboardViolation,
  ManualModerationAction,
  ManualModerationActionRequest,
  ManualModerationScope,
  ChatParticipantItem,
  ChatParticipantRoleFilter,
  ChatParticipantActivityFilter,
  ChatParticipantsPage,
  GlobalSpammerReviewAction,
  GlobalSpammerReviewCandidate,
  GlobalSpammerUserDiagnostics,
  ModerationFeedFilter,
  MembershipActivityItem,
} from '@maxim/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import '../styles/settings-drilldown-core.css';
import '../styles/settings-experience.css';
import '../styles/dashboard-events.css';
import '../styles/statistics-experience.css';
import '../styles/events-participant-navigation.css';
import './statistics-steel.css';
import {
  startTransition,
  Suspense,
  type ComponentProps,
  type CSSProperties,
  type MouseEvent,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import type { ChatParticipantCard as ChatParticipantCardComponent } from '../components/dashboard/chat-participant-card';
import type { ChatSanctionsWorkspace as ChatSanctionsWorkspaceComponent } from '../components/dashboard/chat-sanctions-workspace';
import type { ChatParticipantsRoster as ChatParticipantsRosterComponent } from '../components/dashboard/chat-participants-roster';
import type { MembershipActivityFeed as MembershipActivityFeedComponent } from '../components/dashboard/membership-activity-feed';
import type { ActionConfirmSheet as ActionConfirmSheetComponent } from '../components/ui/action-confirm-sheet';
import { PersonAvatar } from '../components/ui/person-avatar';
import { GlassCard } from '../components/ui/glass-card';
import { ManagedEntityWorkspaceHeader } from '../components/ui/managed-entity-workspace-header';
import { SegmentedControl } from '../components/ui/segmented-control';
import { SettingsDrilldownPanel } from '../components/ui/settings-drilldown-panel';
import { Spinner } from '../components/ui/spinner';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import {
  applyManualModerationAction,
  cleanupUnavailableChatParticipants,
  getChatActivityDashboard,
  getChatActivityFeed,
  getChatModerationDashboard,
  getChatParticipantsPage,
  getChatModerationFeed,
  getChatStatisticsIdentity,
  getGlobalSpammerReviewQueue,
  getGlobalSpammerUserDiagnostics,
  getLogsDashboard,
  handoffChatMemberProfile,
  reviewGlobalSpammerCandidate,
} from '../lib/api/events-client';
import type { ApiTransport } from '../lib/api/transport';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { buildManagedEntitiesRoute, saveLastEntityId } from '../lib/last-chat';
import {
  buildManagedEntitySettingsRoute,
  createManagedEntityWorkspaceState,
  getManagedEntitySessionStorage,
  hasManagedEntityStatsPreference,
  mergeManagedEntityStatsPreference,
  mergeManagedEntityWorkspaceRouteState,
  readManagedEntityWorkspaceState,
  saveManagedEntityStatsPreferenceForWorkspace,
} from '../lib/managed-entity-workspace';
import { openMaxBotLinkAndClose } from '../lib/max-bridge';
import {
  resolveModerationFeedReason,
  trafficModerationLabels,
} from '../lib/moderation-feed-reason';
import { queryKeys } from '../lib/query-keys';
import { isTerminalApiClientError } from '../lib/api-retry';
import {
  buildLogsDashboardSnapshotParts,
  buildChatParticipantsSnapshotParts,
  isLogsDashboardResponseForRange,
  isChatParticipantsPage,
  shouldPrefetchSecondaryEventsDashboard,
  type EventsDashboardPrefetchNetwork,
} from '../lib/logs-dashboard-cache';
import {
  readStatsSnapshot,
  readStatsSnapshotMirror,
  saveStatsSnapshot,
} from '../lib/stats-snapshot-cache';
import {
  formatStatisticsRangeLabel,
  resolveNullableMetricPresentation,
  resolveMembershipMovementShares,
  resolveStatisticsTitle,
} from '../lib/statistics-display';
import {
  buildStatisticsRouteSearch,
  parseChatStatisticsRouteQuery,
} from '../lib/statistics-route-query';
import { useChatParticipantsFeed } from '../lib/use-chat-participants-feed';
import { useMembershipActivityFeed } from '../lib/use-membership-activity-feed';
import { useModerationFeed } from '../lib/use-moderation-feed';
import { useEventFeedRefresh } from '../lib/use-event-feed-refresh';
import { recoverableLazyNamedComponent } from '../lib/recoverable-lazy';
import { describeUserFacingError } from '../lib/user-facing-error';
import { useHintPopoverAutoPosition } from '../lib/hint-popover';
import { describeManualModerationFeedback } from '../lib/manual-moderation-feedback';
import { participantDetailsKey, type ParticipantCardTarget } from '../lib/participant-card';

const ChatParticipantsRoster = recoverableLazyNamedComponent<
  ComponentProps<typeof ChatParticipantsRosterComponent>
>(() => import('../components/dashboard/chat-participants-roster'), 'ChatParticipantsRoster');
const MembershipActivityFeed = recoverableLazyNamedComponent<
  ComponentProps<typeof MembershipActivityFeedComponent>
>(() => import('../components/dashboard/membership-activity-feed'), 'MembershipActivityFeed');
const ChatParticipantCard = recoverableLazyNamedComponent<
  ComponentProps<typeof ChatParticipantCardComponent>
>(() => import('../components/dashboard/chat-participant-card'), 'ChatParticipantCard');
const ChatSanctionsWorkspace = recoverableLazyNamedComponent<
  ComponentProps<typeof ChatSanctionsWorkspaceComponent>
>(() => import('../components/dashboard/chat-sanctions-workspace'), 'ChatSanctionsWorkspace');
const LazyActionConfirmSheet = recoverableLazyNamedComponent<
  ComponentProps<typeof ActionConfirmSheetComponent>
>(() => import('../components/ui/action-confirm-sheet'), 'ActionConfirmSheet');

function ActionConfirmSheet(props: ComponentProps<typeof ActionConfirmSheetComponent>) {
  return props.open ? (
    <Suspense fallback={null}>
      <LazyActionConfirmSheet {...props} />
    </Suspense>
  ) : null;
}

type ViolationItem = LogsDashboardViolation;
type DisplayAction = 'WARN' | 'DELETE_MESSAGE' | 'MUTE' | 'BAN' | 'UNMUTE' | 'UNBAN';
type EventsFilter = ModerationFeedFilter;
type EventsSection = 'activity' | 'moderation' | 'participants';
type ManualModerationScopeChoice = Extract<ManualModerationScope, 'current_chat' | 'all_chats'>;
type SpammerDiagnosticsTarget = {
  userId: string;
  displayName: string;
  avatarUrl?: string | null;
  profileUrl?: string | null;
  profileHandoffUrl?: string | null;
};
type ScoreMeterStyle = CSSProperties & { '--spammer-score': string };
type PendingScopeAction = {
  chatId: string;
  id: string;
  userId: string;
  action: Extract<ManualModerationAction, 'MUTE' | 'BAN'>;
  source: 'participant' | 'spammer-diagnostics';
  muteDurationHours?: number;
  banOnRejoin?: boolean;
};

const MUTE_DURATION_MIN_HOURS = 1;
const MUTE_DURATION_MAX_HOURS = 336;
const PARTICIPANTS_SEARCH_DEBOUNCE_MS = 350;
const IDLE_PREFETCH_DELAY_MS = 700;
const SPAMMER_DIAGNOSTICS_FULL_DELAY_MS = 500;
const SPAMMER_REVIEW_QUEUE_SCOPE = ['PENDING', 20, 'local-profile'] as const;
const SPAMMER_DIAGNOSTICS_LIGHT_SCOPE = 'light' as const;
const SPAMMER_DIAGNOSTICS_FULL_SCOPE = 'full' as const;
const SPAMMER_REVIEW_QUEUE_QUERY = {
  status: 'PENDING',
  limit: 20,
  includeProfiles: true,
  includeObservations: false,
  profileMode: 'local',
} as const;
const SPAMMER_DIAGNOSTICS_LIGHT_QUERY = {
  mode: 'shell',
  includeProfile: true,
  includeObservations: false,
  includeGraphSignals: false,
  includeReputation: false,
  includeCampaigns: false,
  includeShadow: false,
  profileMode: 'local',
} as const;
const SPAMMER_DIAGNOSTICS_FULL_QUERY = {
  mode: 'full',
  includeProfile: false,
  includeReputation: false,
  includeShadow: false,
} as const;

const actionLabelMap: Record<DisplayAction, string> = {
  DELETE_MESSAGE: 'Удаление',
  WARN: 'Предупреждение',
  MUTE: 'Мут',
  BAN: 'Бан',
  UNMUTE: 'Мут снят',
  UNBAN: 'Бан снят',
};

const actionToneMap: Record<DisplayAction, 'neutral' | 'warning' | 'danger' | 'success'> = {
  WARN: 'warning',
  DELETE_MESSAGE: 'neutral',
  MUTE: 'warning',
  BAN: 'danger',
  UNMUTE: 'success',
  UNBAN: 'success',
};

const periodOptions: Array<{ value: LogsDashboardRange; label: string }> = [
  { value: '24h', label: '24ч' },
  { value: '7d', label: '7д' },
  { value: '30d', label: '30д' },
];

function ModerationTabIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M10 2.7 15.8 5v4.1c0 3.4-2 6.1-5.8 8.2-3.8-2.1-5.8-4.8-5.8-8.2V5L10 2.7Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m7.7 10 1.4 1.4 3.3-3.3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ActivityTabIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M3.4 13.8h2.3l1.9-3.5 2.4 5.2 2.1-6 1.2 2.2h3.3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3.3 4.8h13.4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.42"
      />
    </svg>
  );
}

function ParticipantsTabIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M6.3 9.2a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path d="M13.9 8.2a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M3.8 15.7c.2-2.3 2-3.8 4.5-3.8s4.3 1.5 4.5 3.8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M12.1 12.6c.6-.4 1.2-.6 2-.6 1.8 0 3 .9 3.3 2.4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 7.75v4.8l3.45 1.95" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function EventsDashboardSkeleton({ section }: { section: Exclude<EventsSection, 'participants'> }) {
  if (section === 'activity') {
    return (
      <div
        className="events-dashboard__activity events-dashboard__activity--loading"
        role="status"
        aria-label="Загружаем сводку"
      >
        <article className="events-dashboard__activity-balance events-dashboard__activity-balance--loading">
          <span className="events-dashboard__skeleton-line events-dashboard__skeleton-line--label" />
          <span className="events-dashboard__skeleton-line events-dashboard__skeleton-line--value" />
          <span className="events-dashboard__skeleton-line events-dashboard__skeleton-line--short" />
        </article>

        <div className="events-dashboard__activity-ledger">
          <article className="events-dashboard__flow-card events-dashboard__flow-card--loading">
            <span className="events-dashboard__skeleton-line events-dashboard__skeleton-line--label" />
            <span className="events-dashboard__skeleton-line events-dashboard__skeleton-line--metric" />
          </article>
          <article className="events-dashboard__flow-card events-dashboard__flow-card--loading">
            <span className="events-dashboard__skeleton-line events-dashboard__skeleton-line--label" />
            <span className="events-dashboard__skeleton-line events-dashboard__skeleton-line--metric" />
          </article>
          <div className="events-dashboard__flow-bar events-dashboard__flow-bar--loading" />
        </div>
      </div>
    );
  }

  return (
    <div
      className="events-dashboard__body events-dashboard__body--moderation events-dashboard__body--loading"
      role="status"
      aria-label="Загружаем сводку"
    >
      <article className="events-dashboard__hero events-dashboard__hero--loading">
        <span className="events-dashboard__skeleton-line events-dashboard__skeleton-line--label" />
        <span className="events-dashboard__skeleton-line events-dashboard__skeleton-line--value" />
      </article>

      <div className="events-dashboard__stack">
        <article className="events-dashboard__metric events-dashboard__metric--loading">
          <span className="events-dashboard__skeleton-line events-dashboard__skeleton-line--label" />
          <span className="events-dashboard__skeleton-line events-dashboard__skeleton-line--metric" />
        </article>
        <article className="events-dashboard__metric events-dashboard__metric--loading">
          <span className="events-dashboard__skeleton-line events-dashboard__skeleton-line--label" />
          <span className="events-dashboard__skeleton-line events-dashboard__skeleton-line--metric" />
        </article>
      </div>
    </div>
  );
}

function getRouteChatTitle(state: unknown): string {
  if (
    typeof state === 'object' &&
    state &&
    'chatTitle' in state &&
    typeof state.chatTitle === 'string'
  ) {
    return state.chatTitle.trim();
  }

  return '';
}

function getRouteChatAvatarUrl(state: unknown): string | null {
  if (
    typeof state === 'object' &&
    state &&
    'avatarUrl' in state &&
    typeof state.avatarUrl === 'string'
  ) {
    const normalized = state.avatarUrl.trim();
    return normalized || null;
  }

  return null;
}

function buildChatStatsRouteState(
  routeState: unknown,
  chatId: string,
  preference: { section?: EventsSection; range?: LogsDashboardRange },
): Record<string, unknown> {
  const currentWorkspace = readManagedEntityWorkspaceState(routeState);
  const matchingWorkspace =
    currentWorkspace?.entityType === 'chat' && currentWorkspace.entityId === chatId
      ? currentWorkspace
      : null;
  const workspace = createManagedEntityWorkspaceState({
    entityType: 'chat',
    entityId: chatId,
    origin: matchingWorkspace?.origin,
    homeSnapshot: matchingWorkspace?.homeSnapshot,
    statsPreference: mergeManagedEntityStatsPreference(
      'chat',
      matchingWorkspace?.statsPreference,
      preference,
    ),
  });

  return mergeManagedEntityWorkspaceRouteState(routeState, workspace);
}

function saveChatStatsPreference(
  routeState: unknown,
  chatId: string,
  preference: { section?: EventsSection; range?: LogsDashboardRange },
): void {
  saveManagedEntityStatsPreferenceForWorkspace(getManagedEntitySessionStorage(), routeState, {
    entityType: 'chat',
    entityId: chatId,
    preference,
  });
}

function formatViolationRule(ruleCode: string): string {
  const labels: Record<string, string> = {
    ...trafficModerationLabels,
    LINK_BLOCKED: 'Ссылки запрещены',
    PROFANITY: 'Нецензурная лексика',
    COMMERCIAL_AD: 'Коммерция',
    MESSAGE_TOO_LONG: 'Слишком длинное сообщение',
    MESSAGE_RATE_LIMIT: 'Слишком частые сообщения',
    MESSAGE_COUNT_LIMIT: 'Лимит сообщений',
    PHOTO_BLOCKED: 'Фото запрещены',
    VIDEO_BLOCKED: 'Видео запрещено',
    FILE_BLOCKED: 'Файлы запрещены',
    VOICE_BLOCKED: 'Голосовые запрещены',
    FORWARDED_MESSAGE_BLOCKED: 'Пересылки запрещены',
    PHOTO_RATE_LIMIT: 'Слишком много фото',
    STICKER_RATE_LIMIT: 'Слишком много стикеров',
    DUPLICATE_WARN: 'Повторяющиеся сообщения',
    DUPLICATE_DELETE: 'Повторяющиеся сообщения',
    DUPLICATE_MUTE: 'Повторяющиеся сообщения',
    DUPLICATE_KICK: 'Повторяющиеся сообщения',
    DUPLICATE_BAN: 'Повторяющиеся сообщения',
    MANUAL_MUTE: 'Мут модератором',
    MANUAL_UNMUTE: 'Снятие мута',
    MANUAL_KICK: 'Удаление вручную',
    MANUAL_BAN: 'Бан модератором',
    MANUAL_UNBAN: 'Снятие бана',
    THEMATIC_FILTER: 'Объявления по теме',
    GLOBAL_USER_BLACKLIST_KICK: 'Запрет по базе',
    GLOBAL_CROSS_CHAT_SPAM: 'Рассылка по чатам',
    GLOBAL_SPAMMER_BAN: 'База спама',
    GLOBAL_SPAMMER_KICK: 'База спама',
    MUTE_ACTIVE_DELETE: 'Действует запрет сообщений',
    NIGHT_MODE_DELETE: 'Ночной режим',
    REQUIRED_SUBSCRIPTION: 'Обязательная подписка',
  };

  if (ruleCode in labels) {
    return labels[ruleCode];
  }

  if (ruleCode.endsWith('_DELETE')) {
    return formatViolationRule(ruleCode.slice(0, -7));
  }

  return resolveModerationCodeLabel(ruleCode);
}

function resolveModerationCodeLabel(code: string): string {
  const normalized = code.trim().toUpperCase();
  if (!normalized) {
    return 'Нарушение';
  }
  if (normalized.includes('SPAM') || normalized.includes('FANOUT')) {
    return 'Массовая рассылка';
  }
  if (normalized.includes('COMMERCIAL')) {
    return 'Коммерция';
  }
  if (normalized.includes('LINK')) {
    return 'Ссылка';
  }
  if (normalized.includes('PHONE')) {
    return 'Телефон';
  }
  if (normalized.includes('MUTE')) {
    return 'Мут';
  }
  if (normalized.includes('BAN') || normalized.includes('KICK')) {
    return 'Исключение из чата';
  }
  if (normalized.includes('PHOTO')) {
    return 'Фото';
  }
  if (normalized.includes('VIDEO')) {
    return 'Видео';
  }
  if (normalized.includes('VOICE')) {
    return 'Голосовое';
  }
  if (normalized.includes('FILE')) {
    return 'Файл';
  }
  return 'Нарушение';
}

function resolveOffenderName(violation: ViolationItem): string {
  const fromPayload = violation.userDisplayName?.trim();
  if (fromPayload) {
    return fromPayload;
  }

  return 'Неизвестный участник';
}

function resolveOffenderInitial(name: string): string {
  const matched = name.match(/[A-Za-zА-Яа-яЁё0-9]/);
  return matched ? matched[0]!.toUpperCase() : '•';
}

function resolveOffenderAvatarUrl(violation: ViolationItem): string | null {
  const normalized = violation.avatarUrl?.trim() ?? '';
  return normalized || null;
}

function handleProfileLinkClick(
  event: MouseEvent<HTMLAnchorElement>,
  onActivate: () => void,
): void {
  event.preventDefault();
  event.stopPropagation();
  onActivate();
}

function isManualUnban(violation: ViolationItem): boolean {
  return violation.ruleCode === 'MANUAL_UNBAN';
}

function isManualUnmute(violation: ViolationItem): boolean {
  return violation.ruleCode === 'MANUAL_UNMUTE';
}

function resolveDisplayAction(violation: ViolationItem): DisplayAction {
  if (isManualUnmute(violation)) {
    return 'UNMUTE';
  }

  if (isManualUnban(violation)) {
    return 'UNBAN';
  }

  if (violation.action === 'NONE') {
    return 'DELETE_MESSAGE';
  }

  if (violation.action === 'KICK') {
    return 'BAN';
  }

  return violation.action;
}

function resolveViolationBlurb(violation: ViolationItem): string {
  if (violation.ruleCode === 'MANUAL_UNMUTE') {
    return 'Модератор снял ограничение вручную';
  }

  if (violation.ruleCode === 'MANUAL_UNBAN') {
    return 'Модератор снял блокировку';
  }

  if (violation.ruleCode === 'MANUAL_MUTE') {
    const metadata =
      violation.metadata &&
      typeof violation.metadata === 'object' &&
      !Array.isArray(violation.metadata)
        ? violation.metadata
        : null;
    const muteDurationHours =
      metadata &&
      typeof metadata.muteDurationHours === 'number' &&
      Number.isFinite(metadata.muteDurationHours)
        ? metadata.muteDurationHours
        : null;

    return muteDurationHours ? `Мут на ${muteDurationHours} ч` : 'Модератор назначил мут';
  }

  if (violation.ruleCode === 'MANUAL_KICK') {
    return 'Модератор удалил участника';
  }

  if (violation.ruleCode === 'MANUAL_BAN') {
    return 'Модератор назначил бан';
  }

  return formatViolationRule(violation.ruleCode);
}

function formatSignedCount(value: number): string {
  if (value > 0) {
    return `+${value}`;
  }

  return String(value);
}

function clampMuteDurationHours(value: number): number {
  const normalized = Number.isFinite(value) ? Math.trunc(value) : MUTE_DURATION_MIN_HOURS;
  return Math.max(MUTE_DURATION_MIN_HOURS, Math.min(MUTE_DURATION_MAX_HOURS, normalized));
}

function formatMuteDurationCompact(hours: number): string {
  return hours >= 24 && hours % 24 === 0 ? `${hours / 24}д` : `${hours}ч`;
}

function resolveApplyActionLabel(
  action: ManualModerationAction,
  muteDurationHours: number,
): string {
  if (action === 'MUTE') {
    return `Мут на ${formatMuteDurationCompact(muteDurationHours)}`;
  }

  if (action === 'UNMUTE') {
    return 'Снять мут';
  }

  if (action === 'UNBAN') {
    return 'Снять бан';
  }

  return 'Бан';
}

function resolveConfirmMessage(
  action: ManualModerationAction,
  muteDurationHours: number,
  violation?: ViolationItem,
): string {
  if (action === 'MUTE') {
    return `Назначить мут на ${muteDurationHours} ч? Новые сообщения будут удаляться до конца срока.`;
  }

  if (action === 'UNMUTE') {
    return 'Снять мут?';
  }

  if (action === 'UNBAN') {
    if (violation?.metadata?.mode === 'LOCAL_REJOIN') return 'Снять бан?';
    if (violation && isBanActiveFromViolation(violation)) {
      return 'Снять бан и вернуть участника в чат?';
    }

    if (
      violation?.ruleCode === 'GLOBAL_SPAMMER_BAN' ||
      violation?.ruleCode === 'GLOBAL_SPAMMER_KICK'
    ) {
      return 'Вернуть участника в чат и отключить удаление по базе спама?';
    }

    return 'Вернуть участника в чат?';
  }

  return 'Назначить бан участнику?';
}

function isMuteActiveFromViolation(violation: ViolationItem): boolean {
  const metadata =
    violation.metadata &&
    typeof violation.metadata === 'object' &&
    !Array.isArray(violation.metadata)
      ? violation.metadata
      : null;
  const now = Date.now();

  const readFutureIso = (key: string): boolean => {
    if (!metadata || !(key in metadata) || typeof metadata[key] !== 'string') {
      return false;
    }
    const timestamp = new Date(metadata[key] as string).getTime();
    return Number.isFinite(timestamp) && timestamp > now;
  };

  if (
    readFutureIso('muteExpiresAt') ||
    readFutureIso('banExpiresAt') ||
    readFutureIso('unbanScheduledAt')
  ) {
    return true;
  }

  if (violation.action !== 'MUTE') {
    return false;
  }

  const createdAtMs = new Date(violation.createdAt).getTime();
  if (!Number.isFinite(createdAtMs)) {
    return false;
  }

  const muteDurationHours =
    metadata && 'muteDurationHours' in metadata && typeof metadata.muteDurationHours === 'number'
      ? metadata.muteDurationHours
      : null;
  if (muteDurationHours === null || !Number.isFinite(muteDurationHours) || muteDurationHours <= 0) {
    return false;
  }

  return createdAtMs + muteDurationHours * 60 * 60 * 1000 > now;
}

function isBanActiveFromViolation(violation: ViolationItem): boolean {
  const metadata =
    violation.metadata &&
    typeof violation.metadata === 'object' &&
    !Array.isArray(violation.metadata)
      ? violation.metadata
      : null;

  if (violation.action !== 'BAN') {
    return false;
  }

  return !metadata || !('muteDurationHours' in metadata);
}

function resolveReleaseAction(
  violation: ViolationItem,
): Extract<ManualModerationAction, 'UNMUTE' | 'UNBAN'> | null {
  if (isMuteActiveFromViolation(violation)) {
    return 'UNMUTE';
  }

  if (isBanActiveFromViolation(violation)) {
    return 'UNBAN';
  }

  return null;
}

function resolveReleaseLabel(
  action: Extract<ManualModerationAction, 'UNMUTE' | 'UNBAN'>,
  banOnRejoin: boolean,
): string {
  return action === 'UNMUTE'
    ? 'Снять мут'
    : banOnRejoin || isMaxMemberRestoreAvailable()
      ? 'Снять бан'
      : 'Проверить снятие в MAX';
}

function normalizeActionErrorMessage(error: unknown): string {
  return describeUserFacingError(
    error,
    'Не удалось выполнить действие. Проверьте права бота и повторите.',
  );
}

function normalizeLoadErrorMessage(error: unknown): string {
  return describeUserFacingError(
    typeof error === 'string' ? new Error(error) : error,
    'Не удалось загрузить данные. Попробуйте ещё раз.',
  );
}

function formatRussianCountLabel(count: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.trunc(count));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return one;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return few;
  }
  return many;
}

function resolveSpammerReasonLabel(reason: string | null | undefined): string {
  const raw = reason?.trim() ?? '';
  if (!raw) {
    return 'другая причина';
  }

  const normalized = raw.toUpperCase();
  if (normalized.includes('EXEMPT')) {
    return 'администратор не проверяется';
  }
  if (
    normalized.includes('ALLOW') ||
    normalized.includes('SUPPRESS') ||
    normalized.includes('UNBAN') ||
    normalized.includes('FALSE')
  ) {
    return 'исключено вручную';
  }
  if (normalized.includes('NO_ACTIVE') || normalized.includes('USER_ID_REQUIRED')) {
    return 'нет активной записи';
  }
  if (
    /[А-Яа-яЁё]/.test(raw) &&
    !normalized.includes('СХЕМ') &&
    !normalized.includes('РАССЫЛ') &&
    !normalized.includes('БАН') &&
    !normalized.includes('ЖАЛОБ') &&
    !normalized.includes('РЕКЛАМ') &&
    !normalized.includes('ПОВТОР')
  ) {
    return raw;
  }
  return DIAGNOSTICS_SIGNAL_CATEGORIES[resolveSpammerSignalCategory(raw)].reasonLabel;
}

function readUserFacingName(value: string | null | undefined, userId: string | null | undefined) {
  let normalized = value?.trim() ?? '';
  const mentionMatch = normalized.match(
    /^\[([^\]]+)\]\((?:max:\/\/user\/|https?:\/\/max\.ru\/)[^)]+\)$/u,
  );
  if (mentionMatch?.[1]) {
    normalized = mentionMatch[1].trim();
  }
  if (!normalized) {
    return '';
  }

  const normalizedUserId = userId?.trim() ?? '';
  if (normalizedUserId && normalized === normalizedUserId) {
    return '';
  }
  if (/^(?:id)?\d{5,}$/iu.test(normalized)) {
    return '';
  }

  return normalized;
}

function resolveSpammerCandidateName(candidate: GlobalSpammerReviewCandidate): string {
  const chatLabel =
    candidate.chats
      .map((chat) => readUserFacingName(chat.lastUserLabel, candidate.userId))
      .find((label) => label.length > 0) || '';
  return (
    readUserFacingName(candidate.displayName, candidate.userId) ||
    readUserFacingName(candidate.lastUserLabel, candidate.userId) ||
    chatLabel ||
    formatUserReference()
  );
}

function formatUserReference(): string {
  return 'Пользователь';
}

function resolveSpammerCandidateInitial(candidate: GlobalSpammerReviewCandidate): string {
  const name = resolveSpammerCandidateName(candidate);
  const matched = name.match(/[A-Za-zА-Яа-яЁё0-9]/);
  return matched ? matched[0]!.toUpperCase() : 'S';
}

function resolveSpammerCandidateAvatarUrl(candidate: GlobalSpammerReviewCandidate): string | null {
  const normalized = candidate.avatarUrl?.trim() ?? '';
  return normalized || null;
}

function resolveSpammerDiagnosticsName(
  target: SpammerDiagnosticsTarget | null,
  diagnostics: GlobalSpammerUserDiagnostics | null,
): string {
  const userId = diagnostics?.userId ?? target?.userId ?? '';
  return (
    readUserFacingName(diagnostics?.displayName, userId) ||
    readUserFacingName(target?.displayName, userId) ||
    formatUserReference()
  );
}

function resolveSpammerDiagnosticsInitial(
  target: SpammerDiagnosticsTarget | null,
  diagnostics: GlobalSpammerUserDiagnostics | null,
): string {
  const matched = resolveSpammerDiagnosticsName(target, diagnostics).match(/[A-Za-zА-Яа-яЁё0-9]/);
  return matched ? matched[0]!.toUpperCase() : 'S';
}

function resolveSpammerDiagnosticsAvatarUrl(
  target: SpammerDiagnosticsTarget | null,
  diagnostics: GlobalSpammerUserDiagnostics | null,
): string | null {
  const normalized = diagnostics?.avatarUrl?.trim() || target?.avatarUrl?.trim() || '';
  return normalized || null;
}

function resolveSpammerDiagnosticsProfileUrl(
  target: SpammerDiagnosticsTarget | null,
  diagnostics: GlobalSpammerUserDiagnostics | null,
): string {
  return diagnostics?.profileUrl?.trim() || target?.profileUrl?.trim() || '';
}

function resolveSpammerDiagnosticsProfileHandoffUrl(
  target: SpammerDiagnosticsTarget | null,
  diagnostics: GlobalSpammerUserDiagnostics | null,
): string {
  return diagnostics?.profileHandoffUrl?.trim() || target?.profileHandoffUrl?.trim() || '';
}

function formatOptionalDate(value: string | null | undefined): string | null {
  return value ? formatViolationDate(value) : null;
}

function resolveDiagnosticsHeadline(diagnostics: GlobalSpammerUserDiagnostics): string {
  const status = diagnostics.policy.registryStatus;
  if (status === 'ACTIVE_CONFIRMED') {
    return 'В базе спама';
  }
  if (status === 'LOCAL_BLOCKED') {
    return 'Отмечен спамером';
  }
  if (status === 'MEDIUM_REVIEW') {
    return 'На проверке';
  }
  if (status === 'SUPPRESSED' || status === 'ADMIN_EXEMPT') {
    return 'Не учитывается в базе';
  }
  if (status === 'EXPIRED') {
    return 'Нет активной записи';
  }
  return 'Нет активной записи';
}

function resolveDiagnosticsAutoAction(diagnostics: GlobalSpammerUserDiagnostics): string {
  const { policy } = diagnostics;
  if (policy.registryStatus === 'ACTIVE_CONFIRMED' && !policy.deleteSpammersEnabled) {
    return 'Автоматическая блокировка выключена';
  }
  if (policy.registryStatus === 'LOCAL_BLOCKED') {
    return policy.action === 'NONE' ? 'Отметка сохранена' : 'Блокировка при новом сообщении';
  }
  if (policy.action === 'DELETE_AND_KICK') {
    return 'Участник будет заблокирован';
  }
  if (policy.action === 'SHADOW_DELETE_AND_KICK') {
    return 'Ждёт решения админа';
  }
  if (policy.registryStatus === 'ADMIN_EXEMPT') {
    return 'Без автоматической блокировки';
  }
  if (policy.registryStatus === 'SUPPRESSED') {
    return 'Без автоматической блокировки';
  }
  if (policy.registryStatus === 'MEDIUM_REVIEW') {
    return 'Ждёт решения админа';
  }
  if (policy.registryStatus === 'EXPIRED') {
    return 'Без автоматических действий';
  }
  return 'Без автоматических действий';
}

function normalizeDiagnosticsScore(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(1, value));
}

function resolveDiagnosticsConfidenceScore(
  diagnostics: GlobalSpammerUserDiagnostics,
): number | null {
  return normalizeDiagnosticsScore(
    diagnostics.policy.confidenceScore ??
      diagnostics.registry.confidenceScore ??
      diagnostics.candidate?.confidenceScore ??
      diagnostics.policy.shadowScore ??
      null,
  );
}

function buildScoreMeterStyle(score: number): ScoreMeterStyle {
  return { '--spammer-score': `${Math.round(score * 100)}%` };
}

function resolveDiagnosticsVerdictTone(
  diagnostics: GlobalSpammerUserDiagnostics,
): 'danger' | 'warning' | 'success' | 'neutral' {
  const { policy } = diagnostics;
  if (policy.registryStatus === 'LOCAL_BLOCKED') {
    return policy.action === 'NONE' ? 'warning' : 'danger';
  }
  if (policy.registryStatus === 'ACTIVE_CONFIRMED' && !policy.deleteSpammersEnabled) {
    return 'warning';
  }
  if (policy.action === 'DELETE_AND_KICK') {
    return 'danger';
  }
  if (
    policy.registryStatus === 'ACTIVE_CONFIRMED' ||
    policy.registryStatus === 'MEDIUM_REVIEW' ||
    policy.action === 'SHADOW_DELETE_AND_KICK'
  ) {
    return 'warning';
  }
  if (policy.registryStatus === 'SUPPRESSED' || policy.registryStatus === 'ADMIN_EXEMPT') {
    return 'success';
  }
  return 'neutral';
}

type DiagnosticsSignalCategoryKey = 'fanout' | 'bans' | 'ads' | 'system';

const DIAGNOSTICS_SIGNAL_CATEGORIES: Record<
  DiagnosticsSignalCategoryKey,
  { label: string; reasonLabel: string }
> = {
  fanout: { label: 'Массовая рассылка', reasonLabel: 'массовая рассылка' },
  bans: { label: 'Блокировки в других чатах', reasonLabel: 'блокировки в других чатах' },
  ads: { label: 'Реклама и повторы', reasonLabel: 'реклама и повторы' },
  system: { label: 'Алгоритмы системы', reasonLabel: 'алгоритмы системы' },
};

function resolveSpammerSignalCategory(
  value: string | null | undefined,
  fallback: DiagnosticsSignalCategoryKey = 'system',
): DiagnosticsSignalCategoryKey {
  const normalized = value?.trim().toUpperCase() ?? '';
  if (!normalized) {
    return fallback;
  }

  if (
    normalized.includes('MANUAL_BAN') ||
    normalized.includes('SANCTION_BAN') ||
    normalized.includes('SANCTION_KICK') ||
    normalized.includes('LOCAL_ADMIN_BLOCK') ||
    normalized.includes('REVIEW_APPROVED') ||
    normalized.includes('БАН') ||
    normalized.includes('ЖАЛОБ')
  ) {
    return 'bans';
  }
  if (
    normalized.includes('COMMERCIAL') ||
    normalized.includes('REPEATED_LINK') ||
    normalized.includes('REPEATED_PHONE') ||
    normalized.includes('РЕКЛАМ') ||
    normalized.includes('ПОВТОР')
  ) {
    return 'ads';
  }
  if (
    normalized.includes('FANOUT') ||
    normalized.includes('GRAPH') ||
    normalized.includes('CAMPAIGN') ||
    normalized.includes('SCHEME') ||
    normalized.includes('СХЕМ') ||
    normalized.includes('РАССЫЛ')
  ) {
    return 'fanout';
  }
  if (normalized.includes('BAN') || normalized.includes('KICK')) {
    return 'bans';
  }
  if (
    normalized.includes('LINK') ||
    normalized.includes('PHONE') ||
    normalized.includes('URL') ||
    normalized.includes('DOMAIN')
  ) {
    return 'ads';
  }
  return fallback;
}

type DiagnosticsSignalGroup = {
  key: DiagnosticsSignalCategoryKey;
  label: string;
  userSignalCount: number;
  campaignUserSignalCount: number;
  maxScore: number;
};

function formatDisplaySentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return `${trimmed.charAt(0).toLocaleUpperCase('ru-RU')}${trimmed.slice(1)}`;
}

function buildDiagnosticsSignalGroups(
  diagnostics: GlobalSpammerUserDiagnostics,
): DiagnosticsSignalGroup[] {
  const groups = new Map<DiagnosticsSignalCategoryKey, DiagnosticsSignalGroup>();
  const ensureGroup = (category: DiagnosticsSignalCategoryKey, score: number) => {
    const meta = DIAGNOSTICS_SIGNAL_CATEGORIES[category];
    const current = groups.get(category);
    if (current) {
      current.maxScore = Math.max(current.maxScore, score);
      return current;
    }
    const group: DiagnosticsSignalGroup = {
      key: category,
      label: meta.label,
      userSignalCount: 0,
      campaignUserSignalCount: 0,
      maxScore: score,
    };
    groups.set(category, group);
    return group;
  };
  const addUserSignal = (category: DiagnosticsSignalCategoryKey, score: number, count = 1) => {
    const group = ensureGroup(category, score);
    group.userSignalCount += Math.max(1, Math.trunc(count));
  };

  diagnostics.observations.forEach((item) => {
    addUserSignal(resolveSpammerSignalCategory(item.source), item.score);
  });
  diagnostics.graphSignals.forEach((item) => {
    addUserSignal(resolveSpammerSignalCategory(item.source), item.score);
  });
  diagnostics.campaigns.forEach((item) => {
    const category = resolveSpammerSignalCategory(item.signalType, 'fanout');
    const userObservationsCount = item.userObservationsCount;
    const hasUserCampaignSignals =
      typeof userObservationsCount === 'number' && userObservationsCount > 0;
    const group = hasUserCampaignSignals
      ? ensureGroup(category, item.confidenceScore)
      : groups.get(category);
    if (group) {
      group.maxScore = Math.max(group.maxScore, item.confidenceScore);
      if (hasUserCampaignSignals) {
        group.campaignUserSignalCount += Math.trunc(userObservationsCount);
      }
    }
  });

  if (diagnostics.reputationSummary.naturalBanSignals > 0 && !groups.has('bans')) {
    addUserSignal('bans', 0.34, diagnostics.reputationSummary.naturalBanSignals);
  }

  const signalGroups = [...groups.values()];
  signalGroups.forEach((group) => {
    if (group.campaignUserSignalCount > 0) {
      group.userSignalCount = Math.max(group.userSignalCount, group.campaignUserSignalCount);
    }
  });

  return signalGroups
    .filter((group) => group.userSignalCount > 0)
    .sort(
      (left, right) =>
        right.maxScore - left.maxScore || right.userSignalCount - left.userSignalCount,
    )
    .slice(0, 5);
}

function formatDiagnosticsSignalCount(count: number): string {
  return `${count} ${formatRussianCountLabel(count, 'признак', 'признака', 'признаков')}`;
}

function resolveDiagnosticsActiveUntil(diagnostics: GlobalSpammerUserDiagnostics): string | null {
  if (diagnostics.activeSuppression?.suppressedUntil) {
    return formatOptionalDate(diagnostics.activeSuppression.suppressedUntil);
  }
  return formatOptionalDate(diagnostics.policy.expiresAt ?? diagnostics.registry.expiresAt);
}

function buildDiagnosticsFacts(
  diagnostics: GlobalSpammerUserDiagnostics,
): Array<{ label: string; value: string }> {
  const activeUntil = resolveDiagnosticsActiveUntil(diagnostics);
  const facts: Array<{ label: string; value: string }> = [];

  if (activeUntil) {
    facts.push({
      label:
        diagnostics.policy.registryStatus === 'SUPPRESSED' || diagnostics.activeSuppression
          ? 'Не учитывать в спам-базе до'
          : 'Действует до',
      value: activeUntil,
    });
  }
  if (diagnostics.localAdminDecision) {
    const decisionLabels: Record<string, string> = {
      ALLOW: 'Не спамер',
      BLOCK: 'Подтверждён в спам-базе',
      REVIEW: 'Отправить на проверку',
    };
    facts.push({
      label: 'Решение по спам-базе',
      value: decisionLabels[diagnostics.localAdminDecision.decision] ?? 'Решение для этого чата',
    });
  }

  return facts;
}

function GlobalSpammerReviewPanel({
  candidates,
  isLoading,
  error,
  onOpen,
  onWarm,
}: {
  candidates: GlobalSpammerReviewCandidate[];
  isLoading: boolean;
  error: unknown;
  onOpen: () => void;
  onWarm: () => void;
}) {
  const errorMessage = error ? normalizeLoadErrorMessage(error) : null;
  const visibleCandidates = candidates.slice(0, 3);
  const hiddenCandidateCount = Math.max(0, candidates.length - visibleCandidates.length);
  const pendingLabel = `${candidates.length} ${formatRussianCountLabel(
    candidates.length,
    'кандидат',
    'кандидата',
    'кандидатов',
  )} на проверке`;
  const statusLabel = errorMessage ? 'Ошибка загрузки' : isLoading ? 'Обновляем' : pendingLabel;
  const shouldHide = !isLoading && !errorMessage && candidates.length === 0;
  if (shouldHide) {
    return null;
  }

  return (
    <section className="spammer-review" aria-label="Очередь базы спама">
      <button
        type="button"
        className="spammer-review__entry"
        onClick={onOpen}
        onFocus={onWarm}
        onPointerEnter={onWarm}
        onPointerDown={onWarm}
      >
        <span className="spammer-review__mark" aria-hidden="true">
          !
        </span>

        <span className="spammer-review__copy">
          <span className="spammer-review__label">База спама</span>
          <strong>{statusLabel}</strong>
        </span>

        <span className="spammer-review__side" aria-hidden="true">
          {visibleCandidates.length > 0 ? (
            <span className="spammer-review__avatars">
              {visibleCandidates.map((candidate) => (
                <PersonAvatar
                  key={candidate.userId}
                  avatarUrl={resolveSpammerCandidateAvatarUrl(candidate)}
                  fallback={resolveSpammerCandidateInitial(candidate)}
                  className="spammer-review__avatar"
                />
              ))}
              {hiddenCandidateCount > 0 ? (
                <span className="spammer-review__avatar spammer-review__avatar--more">
                  +{hiddenCandidateCount}
                </span>
              ) : null}
            </span>
          ) : null}
          <span className="spammer-review__chevron">›</span>
        </span>
      </button>
    </section>
  );
}

function SpammerReviewSheet({
  open,
  candidates,
  isLoading,
  isRefreshing,
  error,
  onClose,
  onRetry,
  onOpenDiagnostics,
  onWarmDiagnostics,
}: {
  open: boolean;
  candidates: GlobalSpammerReviewCandidate[];
  isLoading: boolean;
  isRefreshing: boolean;
  error: unknown;
  onClose: () => void;
  onRetry: () => void;
  onOpenDiagnostics: (candidate: GlobalSpammerReviewCandidate) => void;
  onWarmDiagnostics?: (candidate: GlobalSpammerReviewCandidate) => void;
}) {
  const errorMessage = error ? normalizeLoadErrorMessage(error) : null;
  const summary =
    candidates.length > 0
      ? `${candidates.length} ${formatRussianCountLabel(
          candidates.length,
          'кандидат',
          'кандидата',
          'кандидатов',
        )} на проверке`
      : undefined;

  return (
    <SettingsDrilldownPanel
      id="spammer-review-sheet"
      open={open}
      title="База спама"
      summary={summary}
      tone="rose"
      onClose={onClose}
      className={`spammer-review-sheet${isRefreshing ? ' spammer-review-sheet--refreshing' : ''}`}
    >
      {isLoading ? (
        <div className="spammer-review-sheet__list" aria-busy="true" aria-label="Загружаем список">
          {[0, 1, 2].map((index) => (
            <div className="spammer-review-sheet__skeleton" key={index} aria-hidden="true">
              <span className="spammer-review-sheet__skeleton-avatar" />
              <span className="spammer-review-sheet__skeleton-copy">
                <span className="spammer-review-sheet__skeleton-line" />
                <span className="spammer-review-sheet__skeleton-line" />
              </span>
            </div>
          ))}
        </div>
      ) : errorMessage ? (
        <div className="spammer-review-sheet__state">
          <span>{errorMessage}</span>
          <button type="button" className="button button--ghost" onClick={onRetry}>
            Обновить
          </button>
        </div>
      ) : candidates.length === 0 ? (
        <div className="spammer-review-sheet__state">
          <span>На проверке никого нет</span>
        </div>
      ) : (
        <div className="spammer-review-sheet__list">
          {isRefreshing ? (
            <div className="spammer-review-sheet__refresh" role="status">
              Обновляем
            </div>
          ) : null}
          {candidates.map((candidate) => {
            const label = resolveSpammerCandidateName(candidate);
            const reason = formatDisplaySentence(resolveSpammerReasonLabel(candidate.lastReason));
            const chatsCount = candidate.chats.length;
            const chatsLabel =
              chatsCount > 0
                ? `${chatsCount} ${formatRussianCountLabel(chatsCount, 'чат', 'чата', 'чатов')}`
                : null;

            return (
              <button
                key={candidate.userId}
                type="button"
                className="spammer-review-sheet__row"
                onFocus={() => onWarmDiagnostics?.(candidate)}
                onPointerEnter={() => onWarmDiagnostics?.(candidate)}
                onPointerDown={() => onWarmDiagnostics?.(candidate)}
                onClick={() => onOpenDiagnostics(candidate)}
              >
                <PersonAvatar
                  avatarUrl={resolveSpammerCandidateAvatarUrl(candidate)}
                  fallback={resolveSpammerCandidateInitial(candidate)}
                  className="spammer-review-sheet__avatar"
                />

                <span className="spammer-review-sheet__person">
                  <strong>{label}</strong>
                  <span>{[reason, chatsLabel].filter(Boolean).join(' · ')}</span>
                </span>

                <span className="spammer-review-sheet__chevron" aria-hidden="true">
                  ›
                </span>
              </button>
            );
          })}
        </div>
      )}
    </SettingsDrilldownPanel>
  );
}

function SpammerDiagnosticsSheet({
  open,
  target,
  diagnostics,
  isLoading,
  isLoadingDetails,
  isRefreshing,
  error,
  reviewingAction,
  isBanning,
  onClose,
  onRetry,
  onReview,
  onBan,
  onProfileActivate,
}: {
  open: boolean;
  target: SpammerDiagnosticsTarget | null;
  diagnostics: GlobalSpammerUserDiagnostics | null;
  isLoading: boolean;
  isLoadingDetails: boolean;
  isRefreshing: boolean;
  error: unknown;
  reviewingAction: GlobalSpammerReviewAction | null;
  isBanning: boolean;
  onClose: () => void;
  onRetry: () => void;
  onReview: (userId: string, action: GlobalSpammerReviewAction) => void;
  onBan: (userId: string) => void;
  onProfileActivate: (userId: string, displayName: string) => void;
}) {
  const [reviewHelpOpen, setReviewHelpOpen] = useState(false);
  useHintPopoverAutoPosition(open && reviewHelpOpen, 'spammerReview', () =>
    setReviewHelpOpen(false),
  );
  useEffect(() => setReviewHelpOpen(false), [open, target?.userId]);
  const errorMessage = error ? normalizeLoadErrorMessage(error) : null;
  const signalGroups = diagnostics ? buildDiagnosticsSignalGroups(diagnostics) : [];
  const facts = diagnostics ? buildDiagnosticsFacts(diagnostics) : [];
  const signalCount = signalGroups.reduce((sum, group) => sum + group.userSignalCount, 0);
  const confidenceScore = diagnostics ? resolveDiagnosticsConfidenceScore(diagnostics) : null;
  const confidencePercent = confidenceScore === null ? null : Math.round(confidenceScore * 100);
  const profileUserId = diagnostics?.userId.trim() || target?.userId.trim() || '';
  const profileDisplayName = resolveSpammerDiagnosticsName(target, diagnostics);
  const profileAvatarUrl = resolveSpammerDiagnosticsAvatarUrl(target, diagnostics);
  const profileUrl = resolveSpammerDiagnosticsProfileUrl(target, diagnostics);
  const profileHandoffUrl = resolveSpammerDiagnosticsProfileHandoffUrl(target, diagnostics);
  const profileHref = profileHandoffUrl || profileUrl || '#';
  const canOpenProfile = profileUserId.length > 0;
  const verdictTone = diagnostics ? resolveDiagnosticsVerdictTone(diagnostics) : 'neutral';
  const canShowShell = Boolean(target || diagnostics);
  const canShowError = Boolean(errorMessage && !diagnostics);
  const isSignalsLoading = isLoading || isLoadingDetails;
  const isReviewing = Boolean(reviewingAction);
  const isActionBusy = isReviewing || isBanning;
  const footer = diagnostics ? (
    <div className="spammer-diagnostics__footer">
      <div
        className="spammer-diagnostics__actions spammer-diagnostics__actions--registry"
        aria-label="Решение по базе спама"
      >
        <button
          type="button"
          className="spammer-diagnostics__action spammer-diagnostics__action--muted"
          disabled={isActionBusy}
          onClick={() => onReview(diagnostics.userId, 'SUPPRESS')}
          aria-label="Отметить, что это не спам, без удаления из чата"
        >
          <span>{reviewingAction === 'SUPPRESS' ? 'Сохраняем...' : 'Не спам'}</span>
          {reviewingAction === 'SUPPRESS' ? null : <small>исключить из проверки</small>}
        </button>
        <button
          type="button"
          className="spammer-diagnostics__action spammer-diagnostics__action--accent"
          disabled={isActionBusy}
          onClick={() => onReview(diagnostics.userId, 'APPROVE')}
          aria-label="Подтвердить спам, без немедленного удаления из чата"
        >
          <span>{reviewingAction === 'APPROVE' ? 'Сохраняем...' : 'Подтвердить спам'}</span>
          {reviewingAction === 'APPROVE' ? null : <small>без удаления сейчас</small>}
        </button>
      </div>
      <div
        className="spammer-diagnostics__actions spammer-diagnostics__actions--chat"
        aria-label="Действие в текущем чате"
      >
        <button
          type="button"
          className="spammer-diagnostics__action spammer-diagnostics__action--danger"
          disabled={isActionBusy}
          onClick={() => onBan(diagnostics.userId)}
          aria-label="Бан участника: выбрать чаты"
        >
          <span>{isBanning ? 'Блокируем...' : 'Бан'}</span>
          {isBanning ? null : <small>выбрать чаты</small>}
        </button>
      </div>
    </div>
  ) : undefined;

  return (
    <SettingsDrilldownPanel
      id="spammer-diagnostics-sheet"
      open={open}
      title="Проверка участника"
      summary=""
      tone="sky"
      onClose={onClose}
      className="spammer-diagnostics-sheet"
      overlayClassName="spammer-diagnostics-overlay"
      headerAction={
        <span className="channel-settings-hint-anchor">
          <button
            type="button"
            className={`settings-info-button${reviewHelpOpen ? ' is-open' : ''}`}
            data-hint-key="spammerReview"
            aria-label="О проверке участника"
            title="О проверке участника"
            aria-expanded={reviewHelpOpen}
            aria-controls="spammer-review-help"
            aria-describedby={reviewHelpOpen ? 'spammer-review-help' : undefined}
            onClick={() => setReviewHelpOpen((current) => !current)}
          >
            <IconoirSprite variant="iconoir" icon="InfoCircle" aria-hidden />
          </button>
          {reviewHelpOpen ? (
            <p id="spammer-review-help" className="channel-settings-hint-popover" role="note">
              Оценка основана на замеченных повторах, рассылках и блокировках. Это не доказательство
              нарушения. «Не спам» исключает участника из этой проверки, но не снимает ограничения в
              чате. «Подтвердить спам» сохраняет ваше решение без немедленного удаления. Дальнейшие
              действия зависят от настроек защиты чата. Для блокировки выберите «Бан» и подтвердите,
              в каких чатах она нужна.
            </p>
          ) : null}
        </span>
      }
      footer={footer}
      keepFooterVisibleWhenKeyboardOpen
    >
      {canShowError ? (
        <div className="spammer-diagnostics__state">
          {canShowShell ? (
            <div className="spammer-diagnostics__profile">
              <PersonAvatar
                avatarUrl={profileAvatarUrl}
                fallback={resolveSpammerDiagnosticsInitial(target, diagnostics)}
                className="spammer-diagnostics__profile-avatar"
              />

              <div className="spammer-diagnostics__profile-copy">
                <strong>{profileDisplayName}</strong>
              </div>
            </div>
          ) : null}
          <span>{errorMessage}</span>
          <button type="button" className="button button--ghost" onClick={onRetry}>
            Обновить
          </button>
        </div>
      ) : canShowShell ? (
        <section
          className={`spammer-diagnostics${isRefreshing ? ' spammer-diagnostics--loading' : ''}`}
        >
          <div className="spammer-diagnostics__profile">
            {canOpenProfile ? (
              <a
                href={profileHref}
                className="spammer-diagnostics__profile-avatar-link"
                aria-label={`Открыть профиль ${profileDisplayName} в MAX`}
                onClick={(event) =>
                  handleProfileLinkClick(event, () =>
                    onProfileActivate(profileUserId, profileDisplayName),
                  )
                }
              >
                <PersonAvatar
                  avatarUrl={profileAvatarUrl}
                  fallback={resolveSpammerDiagnosticsInitial(target, diagnostics)}
                  className="spammer-diagnostics__profile-avatar"
                />
              </a>
            ) : (
              <PersonAvatar
                avatarUrl={profileAvatarUrl}
                fallback={resolveSpammerDiagnosticsInitial(target, diagnostics)}
                className="spammer-diagnostics__profile-avatar"
              />
            )}

            <div className="spammer-diagnostics__profile-copy">
              {canOpenProfile ? (
                <a
                  href={profileHref}
                  className="spammer-diagnostics__profile-name"
                  onClick={(event) =>
                    handleProfileLinkClick(event, () =>
                      onProfileActivate(profileUserId, profileDisplayName),
                    )
                  }
                >
                  {profileDisplayName}
                </a>
              ) : (
                <strong>{profileDisplayName}</strong>
              )}
            </div>
          </div>

          <article
            className={`spammer-diagnostics__hero spammer-diagnostics__hero--${verdictTone}`}
          >
            <div className="spammer-diagnostics__hero-top">
              <span>Статус</span>
              <strong>{diagnostics ? resolveDiagnosticsHeadline(diagnostics) : 'Загружаем'}</strong>
            </div>

            <div className="spammer-diagnostics__hero-main">
              <div className="spammer-diagnostics__verdict-copy">
                <h4>
                  {diagnostics ? resolveDiagnosticsAutoAction(diagnostics) : 'Проверяем историю'}
                </h4>
              </div>

              {confidenceScore !== null && confidencePercent !== null ? (
                <div
                  className="spammer-diagnostics__confidence"
                  role="meter"
                  aria-label="Оценка признаков спама"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={confidencePercent}
                  aria-valuetext={`${confidencePercent} из 100, не доказательство нарушения`}
                  style={buildScoreMeterStyle(confidenceScore)}
                >
                  <span className="spammer-diagnostics__confidence-head">
                    <span>Признаки спама</span>
                    <strong>{confidencePercent} из 100</strong>
                  </span>
                  <span className="spammer-diagnostics__confidence-track" aria-hidden="true">
                    <span className="spammer-diagnostics__confidence-fill" />
                  </span>
                </div>
              ) : null}
            </div>
          </article>

          {isRefreshing ? (
            <div className="spammer-diagnostics__refresh" role="status">
              Обновляем данные
            </div>
          ) : null}

          {facts.length > 0 ? (
            <dl className="spammer-diagnostics__facts" aria-label="Сводка по пользователю">
              {facts.map((item) => (
                <div key={`${item.label}:${item.value}`}>
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          <section className="spammer-diagnostics__signals" aria-label="Причины проверки участника">
            <div className="spammer-diagnostics__section-head">
              <span>Причины проверки</span>
              <strong>
                {signalCount > 0
                  ? formatDiagnosticsSignalCount(signalCount)
                  : isSignalsLoading
                    ? 'Загружаем'
                    : 'Признаков нет'}
              </strong>
            </div>
            {signalGroups.length > 0 ? (
              <div className="spammer-diagnostics__signal-list">
                {signalGroups.map((group) => {
                  return (
                    <article key={group.key} className="spammer-diagnostics__signal-card">
                      <div className="spammer-diagnostics__signal-copy">
                        <strong>
                          {group.label}: {formatDiagnosticsSignalCount(group.userSignalCount)}
                        </strong>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="spammer-diagnostics__empty">
                <strong>
                  {isSignalsLoading ? 'Проверяем историю' : 'Пока нет признаков спама'}
                </strong>
                <span>
                  {isSignalsLoading
                    ? 'Проверяем историю участника.'
                    : 'Повторы и массовые рассылки не найдены.'}
                </span>
              </div>
            )}
          </section>
        </section>
      ) : null}
    </SettingsDrilldownPanel>
  );
}

function ViolationModerationControls({
  api,
  chatId,
  violation,
  onOpenDiagnostics,
  onApplied,
}: {
  api: ApiTransport;
  chatId: string;
  violation: ViolationItem;
  onOpenDiagnostics: () => void;
  onApplied: () => void;
}) {
  const releaseAction = resolveReleaseAction(violation);
  const [muteDurationHours, setMuteDurationHours] = useState(6);
  const [muteExpanded, setMuteExpanded] = useState(false);
  const [pendingScopeChoice, setPendingScopeChoice] = useState<ManualModerationScopeChoice | null>(
    null,
  );
  const [pendingScopeAction, setPendingScopeAction] = useState<{
    action: Extract<ManualModerationAction, 'MUTE' | 'BAN'>;
    muteDurationHours?: number;
  } | null>(null);
  const [pendingAction, setPendingAction] = useState<Extract<
    ManualModerationAction,
    'UNMUTE' | 'UNBAN'
  > | null>(null);
  const [status, setStatus] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const mutePresets = [1, 6, 24, 168];
  const applyLock = useRef(false);

  const applyMutation = useMutation({
    retry: false,
    mutationFn: async (payload: ManualModerationActionRequest) =>
      applyManualModerationAction(api, chatId, violation.userId, payload),
    onSuccess: (result) => {
      setStatus({ tone: 'success', text: describeManualModerationFeedback(result) });
      setMuteExpanded(false);
      setPendingAction(null);
      setPendingScopeAction(null);
      onApplied();
    },
    onError: (error: unknown) => {
      const message = normalizeActionErrorMessage(error);
      setStatus({ tone: 'danger', text: message });
    },
    onSettled: () => {
      applyLock.current = false;
      setPendingScopeChoice(null);
    },
  });

  const applyAction = (
    action: ManualModerationAction,
    hours?: number,
    scope?: ManualModerationScopeChoice,
  ) => {
    if (applyLock.current || applyMutation.isPending) return;
    applyLock.current = true;
    const normalizedHours =
      action === 'MUTE' ? clampMuteDurationHours(hours ?? muteDurationHours) : null;
    setStatus(null);
    setPendingScopeChoice(scope ?? null);
    applyMutation.mutate({
      action,
      ...(action === 'UNBAN' || action === 'UNMUTE'
        ? { expectedSanctionEventId: violation.id }
        : {}),
      ...(scope ? { scope } : {}),
      ...(action === 'MUTE' ? { muteDurationHours: normalizedHours ?? muteDurationHours } : {}),
    });
  };
  const openScopeAction = (
    action: Extract<ManualModerationAction, 'MUTE' | 'BAN'>,
    hours?: number,
  ) => {
    setStatus(null);
    setPendingAction(null);
    setPendingScopeAction({
      action,
      ...(action === 'MUTE'
        ? { muteDurationHours: clampMuteDurationHours(hours ?? muteDurationHours) }
        : {}),
    });
  };
  const closeScopeAction = () => {
    if (applyLock.current || applyMutation.isPending) {
      return;
    }
    setPendingScopeAction(null);
  };
  const confirmScopeAction = (scope: ManualModerationScopeChoice) => {
    if (!pendingScopeAction) {
      return;
    }
    applyAction(pendingScopeAction.action, pendingScopeAction.muteDurationHours, scope);
  };

  return (
    <section className="logs-violation-item__moderation" aria-label="Действия модератора">
      <div
        className={`logs-violation-item__quick-actions ${
          releaseAction ? 'logs-violation-item__quick-actions--single' : ''
        }`}
      >
        <button
          type="button"
          className="logs-violation-item__quick-button logs-violation-item__quick-button--neutral"
          disabled={applyMutation.isPending}
          onClick={() => {
            setStatus(null);
            setMuteExpanded(false);
            setPendingScopeAction(null);
            setPendingAction(null);
            onOpenDiagnostics();
          }}
        >
          Проверить
        </button>
        {!releaseAction ? (
          <button
            type="button"
            className={`logs-violation-item__quick-button logs-violation-item__quick-button--warning ${
              muteExpanded ? 'is-active' : ''
            }`}
            disabled={applyMutation.isPending}
            onClick={() => {
              setStatus(null);
              setPendingAction(null);
              setPendingScopeAction(null);
              setMuteExpanded((current) => !current);
            }}
          >
            Мут
          </button>
        ) : null}
        {!releaseAction ? (
          <button
            type="button"
            className="logs-violation-item__quick-button logs-violation-item__quick-button--danger"
            disabled={applyMutation.isPending}
            onClick={() => {
              setStatus(null);
              setMuteExpanded(false);
              setPendingScopeAction((current) =>
                current?.action === 'BAN'
                  ? null
                  : {
                      action: 'BAN',
                    },
              );
              setPendingAction(null);
            }}
          >
            Бан
          </button>
        ) : null}
        {releaseAction ? (
          <button
            type="button"
            className="logs-violation-item__quick-button logs-violation-item__quick-button--success"
            disabled={applyMutation.isPending}
            onClick={() => {
              setStatus(null);
              setMuteExpanded(false);
              setPendingScopeAction(null);
              setPendingAction((current) => (current === releaseAction ? null : releaseAction));
            }}
          >
            {resolveReleaseLabel(releaseAction, violation.metadata?.mode === 'LOCAL_REJOIN')}
          </button>
        ) : null}
      </div>

      {!releaseAction && muteExpanded ? (
        <div className="logs-violation-item__ban-config">
          <div className="logs-violation-item__duration-summary">
            <div className="logs-violation-item__duration-label">
              <ClockIcon />
              <span>Срок ограничения</span>
            </div>
            <output className="logs-violation-item__duration-output" aria-live="polite">
              {formatMuteDurationCompact(muteDurationHours)}
            </output>
          </div>

          <div className="logs-violation-item__ban-presets">
            {mutePresets.map((hours) => (
              <button
                key={hours}
                type="button"
                className={`logs-violation-item__ban-preset ${
                  muteDurationHours === hours ? 'is-active' : ''
                }`}
                disabled={applyMutation.isPending}
                aria-pressed={muteDurationHours === hours}
                onClick={() => setMuteDurationHours(hours)}
              >
                {formatMuteDurationCompact(hours)}
              </button>
            ))}
          </div>

          <div className="logs-violation-item__ban-config-controls">
            <div className="ban-duration-stepper">
              <button
                type="button"
                className="ban-duration-stepper__button"
                onClick={() => setMuteDurationHours((prev) => clampMuteDurationHours(prev - 1))}
                disabled={applyMutation.isPending || muteDurationHours <= MUTE_DURATION_MIN_HOURS}
                aria-label="Уменьшить срок ограничения"
              >
                -
              </button>
              <div className="ban-duration-stepper__value">
                {formatMuteDurationCompact(muteDurationHours)}
              </div>
              <button
                type="button"
                className="ban-duration-stepper__button"
                onClick={() => setMuteDurationHours((prev) => clampMuteDurationHours(prev + 1))}
                disabled={applyMutation.isPending || muteDurationHours >= MUTE_DURATION_MAX_HOURS}
                aria-label="Увеличить срок ограничения"
              >
                +
              </button>
            </div>

            <label className="logs-violation-item__hours-input">
              <span>Часы</span>
              <input
                type="number"
                min={MUTE_DURATION_MIN_HOURS}
                max={MUTE_DURATION_MAX_HOURS}
                step={1}
                value={muteDurationHours}
                disabled={applyMutation.isPending}
                onChange={(event) =>
                  setMuteDurationHours(clampMuteDurationHours(Number(event.target.value)))
                }
              />
              <small>1–336ч</small>
            </label>
          </div>

          <button
            type="button"
            className="button button--accent logs-violation-item__apply-button"
            disabled={applyMutation.isPending}
            onClick={() => openScopeAction('MUTE', muteDurationHours)}
          >
            {applyMutation.isPending
              ? 'Применяем…'
              : resolveApplyActionLabel('MUTE', muteDurationHours)}
          </button>
        </div>
      ) : null}

      {pendingAction ? (
        <div className="logs-violation-item__ban-config">
          <p className="settings-native-toggle__hint settings-native-toggle__hint--inline">
            {resolveConfirmMessage(pendingAction, muteDurationHours, violation)}
          </p>
          <div className="logs-violation-item__confirm-actions">
            <button
              type="button"
              className="button button--ghost"
              disabled={applyMutation.isPending}
              onClick={() => setPendingAction(null)}
            >
              Отмена
            </button>
            <button
              type="button"
              className="button button--accent"
              disabled={applyMutation.isPending}
              onClick={() => applyAction(pendingAction)}
            >
              {applyMutation.isPending
                ? 'Применяем…'
                : resolveApplyActionLabel(pendingAction, muteDurationHours)}
            </button>
          </div>
        </div>
      ) : null}

      {pendingScopeAction ? (
        <ActionConfirmSheet
          id={`violation-scope-${violation.id}`}
          open
          title={pendingScopeAction.action === 'BAN' ? 'Бан участника' : 'Мут участника'}
          summary={resolveOffenderName(violation)}
          previewTitle={resolveConfirmMessage(
            pendingScopeAction.action,
            pendingScopeAction.muteDurationHours ?? muteDurationHours,
          )}
          previewMeta={
            status?.tone === 'danger' ? <span role="alert">{status.text}</span> : undefined
          }
          confirmLabel="В этом чате"
          confirmBusyLabel="Применяем..."
          cancelLabel="Отмена"
          tone={pendingScopeAction.action === 'BAN' ? 'danger' : 'accent'}
          isBusy={applyMutation.isPending}
          confirmBusy={applyMutation.isPending && pendingScopeChoice === 'current_chat'}
          extraActionLabel="Во всех чатах"
          extraActionBusyLabel="Применяем..."
          extraActionBusy={applyMutation.isPending && pendingScopeChoice === 'all_chats'}
          extraActionTone={pendingScopeAction.action === 'BAN' ? 'danger' : 'accent'}
          actionOrder="confirm-extra-cancel"
          onExtraAction={() => confirmScopeAction('all_chats')}
          onClose={closeScopeAction}
          onConfirm={() => confirmScopeAction('current_chat')}
        />
      ) : null}

      {status ? (
        <p className={`logs-violation-item__action-status is-${status.tone}`}>{status.text}</p>
      ) : null}
    </section>
  );
}

function formatViolationDate(value: string): string {
  return new Date(value).toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function useDebouncedValue(value: string, delayMs: number): string {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedValue(value);
    }, delayMs);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [delayMs, value]);

  return debouncedValue;
}

async function measureDashboardRequest<T>(label: string, task: () => Promise<T>): Promise<T> {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') {
    return task();
  }

  const started = `events-dashboard:${label}:start`;
  const finished = `events-dashboard:${label}:end`;
  const measured = `events-dashboard:${label}`;
  performance.mark(started);
  try {
    return await task();
  } finally {
    performance.mark(finished);
    performance.measure(measured, started, finished);
    performance.clearMarks(started);
    performance.clearMarks(finished);
  }
}

function readEventsDashboardPrefetchNetwork(): EventsDashboardPrefetchNetwork | null {
  if (typeof navigator === 'undefined') {
    return null;
  }

  return (
    (navigator as Navigator & { connection?: EventsDashboardPrefetchNetwork }).connection ?? null
  );
}

export function EventsPage({ api }: { api: ApiTransport }) {
  const { chatId } = useParams();
  return <EventsWorkspace key={chatId ?? ''} api={api} />;
}

function EventsWorkspace({ api }: { api: ApiTransport }) {
  const { chatId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const scopeActionLock = useRef(false);
  const cleanupLock = useRef(false);
  const profileLock = useRef(false);
  const activeView = useRef(true);
  const [range, setRange] = useState<LogsDashboardRange>(
    () => parseChatStatisticsRouteQuery(location.search).range,
  );
  const [section, setSection] = useState<EventsSection>(
    () => parseChatStatisticsRouteQuery(location.search).section,
  );
  const expandedText = useExpandedText();
  const sectionTabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const track = sectionTabsRef.current;
    const selected = track?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!track || !selected) return;
    const revealSelected = () => {
      const item = selected.getBoundingClientRect();
      const bounds = track.getBoundingClientRect();
      if (item.left < bounds.left || item.right > bounds.right) {
        track.scrollLeft += item.left - bounds.left - (track.clientWidth - item.width) / 2;
      }
    };
    revealSelected();
    const observer = new ResizeObserver(revealSelected);
    observer.observe(track);
    observer.observe(selected);
    return () => observer.disconnect();
  }, [section, expandedText]);
  const moderationView =
    new URLSearchParams(location.search).get('moderationView') === 'history'
      ? 'history'
      : 'sanctions';
  const isSanctionsView = section === 'moderation' && moderationView === 'sanctions';
  const sanctionsUserId = new URLSearchParams(location.search).get('sanctionUser');
  const changeModerationView = (view: 'history' | 'sanctions', userId?: string) => {
    const params = new URLSearchParams(location.search);
    params.set('moderationView', view);
    params.set('section', 'moderation');
    if (userId) params.set('sanctionUser', userId);
    else params.delete('sanctionUser');
    navigate(
      { pathname: location.pathname, search: `?${params}`, hash: location.hash },
      { state: location.state },
    );
  };
  const routeQuery = useMemo(
    () => parseChatStatisticsRouteQuery(location.search),
    [location.search],
  );
  const [eventsFilter, setEventsFilter] = useState<EventsFilter>('ALL');
  const [expandedViolationId, setExpandedViolationId] = useState<string | null>(null);
  const [spammerReviewOpen, setSpammerReviewOpen] = useState(false);
  const [participantTarget, setParticipantTarget] = useState<ParticipantCardTarget | null>(null);
  const [participantSavedVersion, setParticipantSavedVersion] = useState(0);
  const selectedParticipant = participantTarget?.chatId === chatId ? participantTarget : null;
  const [cleanupUnavailableConfirmOpen, setCleanupUnavailableConfirmOpen] = useState(false);
  const [spammerDiagnosticsTarget, setSpammerDiagnosticsTarget] =
    useState<SpammerDiagnosticsTarget | null>(null);
  const [pendingScopeAction, setPendingScopeAction] = useState<PendingScopeAction | null>(null);
  const [pendingScopeChoice, setPendingScopeChoice] = useState<ManualModerationScopeChoice | null>(
    null,
  );
  const [spammerDiagnosticsFullEnabledFor, setSpammerDiagnosticsFullEnabledFor] = useState<
    string | null
  >(null);
  const [participantsSearch, setParticipantsSearch] = useState('');
  const [participantsRoleFilter, setParticipantsRoleFilter] =
    useState<ChatParticipantRoleFilter>('all');
  const [participantsActivityFilter, setParticipantsActivityFilter] =
    useState<ChatParticipantActivityFilter>('all');
  const [lastKnownParticipantsTotal, setLastKnownParticipantsTotal] = useState<{
    chatId: string | null;
    total: number;
  } | null>(null);
  const deferredParticipantsSearch = useDeferredValue(participantsSearch);
  const debouncedParticipantsSearch = useDebouncedValue(
    deferredParticipantsSearch.trim(),
    PARTICIPANTS_SEARCH_DEBOUNCE_MS,
  );

  useEffect(() => {
    startTransition(() => {
      setSection(routeQuery.section);
      setRange(routeQuery.range);
    });
    if (chatId) {
      saveChatStatsPreference(location.state, chatId, routeQuery);
    }

    const nextSearch = buildStatisticsRouteSearch(location.search, routeQuery);
    const routeStateHasCurrentStatsPreference = chatId
      ? hasManagedEntityStatsPreference(location.state, {
          entityType: 'chat',
          entityId: chatId,
          preference: routeQuery,
        })
      : true;
    if (nextSearch === location.search && routeStateHasCurrentStatsPreference) {
      return;
    }

    navigate(
      {
        pathname: location.pathname,
        search: nextSearch,
        hash: location.hash,
      },
      {
        replace: true,
        state: chatId
          ? buildChatStatsRouteState(location.state, chatId, routeQuery)
          : location.state,
      },
    );
  }, [
    chatId,
    location.hash,
    location.pathname,
    location.search,
    location.state,
    navigate,
    routeQuery,
  ]);
  const initialParticipantsPageSnapshot = useMemo(() => {
    if (
      !chatId ||
      section !== 'participants' ||
      debouncedParticipantsSearch ||
      participantsRoleFilter !== 'all' ||
      participantsActivityFilter !== 'all'
    ) {
      return null;
    }

    const snapshot = readStatsSnapshotMirror<ChatParticipantsPage>(
      'chat-participants-feed-v2',
      buildChatParticipantsSnapshotParts(chatId, range, '', participantsRoleFilter),
    );
    return isChatParticipantsPage(snapshot) ? snapshot : null;
  }, [
    chatId,
    debouncedParticipantsSearch,
    participantsRoleFilter,
    participantsActivityFilter,
    range,
    section,
  ]);

  const routeChatTitle = getRouteChatTitle(location.state);
  const routeChatAvatarUrl = getRouteChatAvatarUrl(location.state);
  const includeActivityPreview = section === 'activity';
  const includeModerationPreview = section === 'moderation';
  const initialDashboardSnapshot = useMemo(() => {
    if (!chatId || section === 'participants' || isSanctionsView) {
      return null;
    }

    const snapshot = readStatsSnapshotMirror<LogsDashboardResponse>(
      'chat',
      buildLogsDashboardSnapshotParts(
        chatId,
        range,
        includeActivityPreview,
        includeModerationPreview,
      ),
    );
    return isLogsDashboardResponseForRange(snapshot, chatId, range) ? snapshot : null;
  }, [chatId, includeActivityPreview, includeModerationPreview, range, section]);

  useEffect(() => {
    if (chatId) {
      saveLastEntityId('chat', chatId);
    }
  }, [chatId]);

  useEffect(() => {
    activeView.current = true;
    document.body.classList.add('events-page-open');

    return () => {
      activeView.current = false;
      document.body.classList.remove('events-page-open');
    };
  }, []);

  const dashboardQuery = useQuery({
    queryKey: queryKeys.logsDashboard(
      chatId ?? '',
      range,
      includeActivityPreview,
      includeModerationPreview,
    ),
    queryFn: ({ signal }) => {
      const targetChatId = chatId ?? '';
      if (section === 'activity') {
        return measureDashboardRequest('activity', () =>
          getChatActivityDashboard(api, targetChatId, range, { signal }),
        );
      }

      if (section === 'moderation') {
        return measureDashboardRequest('moderation', () =>
          getChatModerationDashboard(api, targetChatId, range, { signal }),
        );
      }

      return measureDashboardRequest('legacy', () =>
        getLogsDashboard(
          api,
          targetChatId,
          range,
          {
            includeActivityPreview,
            includeModerationPreview,
          },
          { signal },
        ),
      );
    },
    enabled: Boolean(chatId) && section !== 'participants' && !isSanctionsView,
    staleTime: 30_000,
    initialData: initialDashboardSnapshot ?? undefined,
    initialDataUpdatedAt: initialDashboardSnapshot ? 0 : undefined,
    refetchInterval: (query) => (isTerminalApiClientError(query.state.error) ? false : 30_000),
    refetchOnWindowFocus: true,
  });
  const participantsIdentityQuery = useQuery({
    queryKey: ['chat-statistics-identity', chatId],
    queryFn: ({ signal }) => getChatStatisticsIdentity(api, chatId ?? '', { signal }),
    enabled: Boolean(chatId) && (section === 'participants' || isSanctionsView),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!chatId || section === 'participants') {
      return undefined;
    }

    let cancelled = false;
    void readStatsSnapshot<LogsDashboardResponse>(
      'chat',
      buildLogsDashboardSnapshotParts(
        chatId,
        range,
        includeActivityPreview,
        includeModerationPreview,
      ),
    ).then((snapshot) => {
      if (cancelled || !isLogsDashboardResponseForRange(snapshot, chatId, range)) {
        return;
      }

      const queryKey = queryKeys.logsDashboard(
        chatId,
        range,
        includeActivityPreview,
        includeModerationPreview,
      );
      if (!queryClient.getQueryData(queryKey)) {
        queryClient.setQueryData(queryKey, snapshot, { updatedAt: 0 });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    chatId,
    includeActivityPreview,
    includeModerationPreview,
    queryClient,
    range,
    section,
    isSanctionsView,
  ]);

  useEffect(() => {
    if (!chatId || !isLogsDashboardResponseForRange(dashboardQuery.data, chatId, range)) {
      return;
    }

    saveStatsSnapshot(
      'chat',
      buildLogsDashboardSnapshotParts(
        chatId,
        range,
        includeActivityPreview,
        includeModerationPreview,
      ),
      dashboardQuery.data,
    );
  }, [chatId, dashboardQuery.data, includeActivityPreview, includeModerationPreview, range]);

  const prefetchParticipantsCount =
    chatId && isLogsDashboardResponseForRange(dashboardQuery.data, chatId, range)
      ? dashboardQuery.data.chat.participantsCount
      : undefined;
  useEffect(() => {
    if (
      !chatId ||
      section === 'participants' ||
      isSanctionsView ||
      prefetchParticipantsCount === undefined
    ) {
      return undefined;
    }

    if (
      !shouldPrefetchSecondaryEventsDashboard({
        range,
        participantsCount: prefetchParticipantsCount,
        network: readEventsDashboardPrefetchNetwork(),
      })
    ) {
      return undefined;
    }

    const targetSection: Extract<EventsSection, 'activity' | 'moderation'> =
      section === 'moderation' ? 'activity' : 'moderation';
    const prefetch = () => {
      const isActivity = targetSection === 'activity';
      void queryClient
        .prefetchQuery({
          queryKey: queryKeys.logsDashboard(chatId, range, isActivity, !isActivity),
          queryFn: ({ signal }) =>
            isActivity
              ? getChatActivityDashboard(api, chatId, range, { signal })
              : getChatModerationDashboard(api, chatId, range, { signal }),
          staleTime: 30_000,
        })
        .catch(() => undefined);
    };

    if ('requestIdleCallback' in window && typeof window.requestIdleCallback === 'function') {
      const idleId = window.requestIdleCallback(prefetch, { timeout: 2_000 });
      return () => window.cancelIdleCallback?.(idleId);
    }

    const timeoutId = window.setTimeout(prefetch, IDLE_PREFETCH_DELAY_MS);
    return () => window.clearTimeout(timeoutId);
  }, [api, chatId, prefetchParticipantsCount, queryClient, range, section, isSanctionsView]);

  const dashboard =
    chatId && isLogsDashboardResponseForRange(dashboardQuery.data, chatId, range)
      ? dashboardQuery.data
      : null;
  const currentDashboardIdentity =
    dashboard && !dashboardQuery.isPlaceholderData ? dashboard : null;
  const participantsIdentity =
    chatId && participantsIdentityQuery.data?.id === chatId ? participantsIdentityQuery.data : null;
  const currentChatIdentity =
    section === 'participants' || isSanctionsView
      ? participantsIdentity
      : currentDashboardIdentity?.chat;
  const chatTitleResolution = useMemo(
    () =>
      resolveStatisticsTitle({
        remoteTitle: currentChatIdentity?.title,
        remoteFallbackTitles: chatId
          ? [`Чат ${chatId}`, `Chat ${chatId}`, `Канал ${chatId}`, `Channel ${chatId}`]
          : [],
        routeTitle: routeChatTitle,
        storedTitle: chatId ? readChatTitle(chatId) : null,
        fallback: chatId ? 'Чат без названия' : '',
      }),
    [chatId, currentChatIdentity?.title, routeChatTitle],
  );
  const chatTitle = chatTitleResolution.title;
  const authoritativeDashboardIdentity =
    currentDashboardIdentity &&
    dashboardQuery.isSuccess &&
    !dashboardQuery.isFetching &&
    !dashboardQuery.isPlaceholderData &&
    !dashboardQuery.isRefetchError &&
    dashboardQuery.dataUpdatedAt > 0
      ? currentDashboardIdentity.chat
      : null;
  const authoritativeParticipantsIdentity =
    participantsIdentity &&
    participantsIdentityQuery.isSuccess &&
    !participantsIdentityQuery.isFetching &&
    !participantsIdentityQuery.isRefetchError &&
    participantsIdentityQuery.dataUpdatedAt > 0
      ? participantsIdentity
      : null;
  const authoritativeChatIdentity =
    section === 'participants' || isSanctionsView
      ? authoritativeParticipantsIdentity
      : authoritativeDashboardIdentity;

  const chatAvatarUrl = useMemo(() => {
    if (!chatId) {
      return null;
    }

    const fromRemote = currentChatIdentity?.avatarUrl;
    if (typeof fromRemote === 'string' && fromRemote.trim()) {
      return fromRemote.trim();
    }

    if (authoritativeChatIdentity) {
      return null;
    }

    if (routeChatAvatarUrl) {
      return routeChatAvatarUrl;
    }

    return null;
  }, [authoritativeChatIdentity, chatId, currentChatIdentity?.avatarUrl, routeChatAvatarUrl]);

  useEffect(() => {
    if (!chatId || !chatTitle || chatTitleResolution.source === 'fallback') {
      return;
    }

    if (chatTitleResolution.source === 'remote' && !authoritativeChatIdentity) {
      return;
    }

    saveChatTitle(chatId, chatTitle);
  }, [authoritativeChatIdentity, chatId, chatTitle, chatTitleResolution.source]);
  const isDashboardPending =
    !dashboard &&
    (dashboardQuery.isLoading || dashboardQuery.isFetching || dashboardQuery.isPlaceholderData);
  const hasBlockingDashboardError = Boolean(dashboardQuery.error) && !dashboard;
  const membershipSummary = dashboard?.membership ?? {
    joinedUsers: 0,
    leftUsers: 0,
    netUsers: 0,
  };
  const violationsSummary = dashboard?.violationsSummary ?? {
    warn: 0,
    deleteMessage: 0,
    mute: 0,
    ban: 0,
    unmute: 0,
    unban: 0,
    affectedUsers: 0,
    total: 0,
  };
  const activityFeed = useMembershipActivityFeed({
    entityId: chatId ?? '',
    enabled: Boolean(chatId) && section === 'activity',
    range,
    initialPage: includeActivityPreview ? (dashboard?.activityFeed ?? null) : null,
    loadPage: (query, request) => getChatActivityFeed(api, chatId ?? '', query, request),
  });
  const moderationFeed = useModerationFeed({
    chatId: chatId ?? '',
    enabled: Boolean(chatId) && section === 'moderation' && !isSanctionsView,
    range,
    filter: eventsFilter,
    initialPage: includeModerationPreview ? (dashboard?.moderationFeed ?? null) : null,
    loadPage: (query, request) => getChatModerationFeed(api, chatId ?? '', query, request),
  });
  useEventFeedRefresh({
    enabled: Boolean(chatId) && section !== 'participants' && !isSanctionsView,
    scopeKey: JSON.stringify([chatId, section, range, eventsFilter, activityFeed.filter]),
    feed: section === 'activity' ? activityFeed : moderationFeed,
  });
  const spammerReviewQueueKey = queryKeys.globalSpammerReviewQueue(
    chatId,
    ...SPAMMER_REVIEW_QUEUE_SCOPE,
  );
  const spammerReviewQueueQuery = useQuery({
    queryKey: spammerReviewQueueKey,
    queryFn: ({ signal }) =>
      getGlobalSpammerReviewQueue(api, chatId ?? '', SPAMMER_REVIEW_QUEUE_QUERY, { signal }),
    enabled:
      Boolean(chatId) && ((section === 'moderation' && !isSanctionsView) || spammerReviewOpen),
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    placeholderData: (previousData) => previousData,
    refetchOnWindowFocus: false,
  });
  const spammerDiagnosticsUserId = spammerDiagnosticsTarget?.userId.trim() || null;
  const spammerDiagnosticsLightQuery = useQuery({
    queryKey: queryKeys.globalSpammerUserDiagnostics(
      chatId,
      spammerDiagnosticsUserId,
      SPAMMER_DIAGNOSTICS_LIGHT_SCOPE,
    ),
    queryFn: ({ signal }) =>
      getGlobalSpammerUserDiagnostics(
        api,
        chatId ?? '',
        spammerDiagnosticsUserId ?? '',
        SPAMMER_DIAGNOSTICS_LIGHT_QUERY,
        {
          signal,
        },
      ),
    enabled: Boolean(chatId && spammerDiagnosticsUserId),
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
  const spammerDiagnosticsFullQuery = useQuery({
    queryKey: queryKeys.globalSpammerUserDiagnostics(
      chatId,
      spammerDiagnosticsUserId,
      SPAMMER_DIAGNOSTICS_FULL_SCOPE,
    ),
    queryFn: ({ signal }) =>
      getGlobalSpammerUserDiagnostics(
        api,
        chatId ?? '',
        spammerDiagnosticsUserId ?? '',
        SPAMMER_DIAGNOSTICS_FULL_QUERY,
        {
          signal,
        },
      ),
    enabled: Boolean(
      chatId &&
      spammerDiagnosticsUserId &&
      spammerDiagnosticsFullEnabledFor === spammerDiagnosticsUserId,
    ),
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
  const spammerDiagnosticsLight =
    spammerDiagnosticsLightQuery.data?.userId === spammerDiagnosticsUserId
      ? spammerDiagnosticsLightQuery.data
      : null;
  const spammerDiagnosticsFull =
    spammerDiagnosticsFullQuery.data?.userId === spammerDiagnosticsUserId
      ? spammerDiagnosticsFullQuery.data
      : null;
  const spammerDiagnostics = spammerDiagnosticsFull ?? spammerDiagnosticsLight ?? null;
  const isSpammerDiagnosticsFullScheduled = Boolean(
    spammerDiagnosticsLight &&
    !spammerDiagnosticsFull &&
    spammerDiagnosticsUserId &&
    spammerDiagnosticsFullEnabledFor !== spammerDiagnosticsUserId,
  );
  const spammerDiagnosticsError =
    spammerDiagnosticsFullQuery.error && spammerDiagnostics
      ? spammerDiagnosticsLightQuery.error
      : (spammerDiagnosticsFullQuery.error ?? spammerDiagnosticsLightQuery.error);
  const isSpammerDiagnosticsLoading =
    Boolean(spammerDiagnosticsTarget) &&
    !spammerDiagnostics &&
    (spammerDiagnosticsLightQuery.isFetching || spammerDiagnosticsFullQuery.isFetching);
  const isSpammerDiagnosticsRefreshing =
    Boolean(spammerDiagnostics) &&
    (spammerDiagnosticsLightQuery.isFetching || spammerDiagnosticsFullQuery.isFetching);
  const isSpammerDiagnosticsLoadingDetails = Boolean(
    spammerDiagnosticsLight &&
    !spammerDiagnosticsFull &&
    (spammerDiagnosticsFullQuery.isFetching || isSpammerDiagnosticsFullScheduled),
  );

  useEffect(() => {
    setSpammerDiagnosticsFullEnabledFor(null);
  }, [spammerDiagnosticsUserId]);

  useEffect(() => {
    if (!chatId || !spammerDiagnosticsUserId || !spammerDiagnosticsLight) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setSpammerDiagnosticsFullEnabledFor(spammerDiagnosticsUserId);
    }, SPAMMER_DIAGNOSTICS_FULL_DELAY_MS);

    return () => window.clearTimeout(timeoutId);
  }, [chatId, spammerDiagnosticsLight, spammerDiagnosticsUserId]);
  const participantsFeed = useChatParticipantsFeed({
    chatId: chatId ?? '',
    enabled: Boolean(chatId) && section === 'participants',
    range,
    roleFilter: participantsRoleFilter,
    activityFilter: participantsActivityFilter,
    search: debouncedParticipantsSearch,
    initialPage: initialParticipantsPageSnapshot,
    refetchInitialPage: Boolean(initialParticipantsPageSnapshot),
    loadPage: (query, request) => getChatParticipantsPage(api, chatId ?? '', query, request),
  });
  const fullParticipantsTotal =
    section === 'participants' && participantsFeed.updatedAt !== null
      ? (participantsFeed.totalCount ?? currentChatIdentity?.participantsCount)
      : (currentChatIdentity?.participantsCount ?? participantsFeed.totalCount);

  useEffect(() => {
    if (
      !chatId ||
      section !== 'participants' ||
      debouncedParticipantsSearch ||
      participantsRoleFilter !== 'all' ||
      participantsActivityFilter !== 'all'
    ) {
      return;
    }
    if (!participantsFeed.firstPage) {
      return;
    }

    saveStatsSnapshot(
      'chat-participants-feed-v2',
      buildChatParticipantsSnapshotParts(chatId, range, '', participantsRoleFilter),
      participantsFeed.firstPage,
    );
  }, [
    chatId,
    debouncedParticipantsSearch,
    participantsFeed.firstPage,
    participantsRoleFilter,
    participantsActivityFilter,
    range,
    section,
  ]);

  useEffect(() => {
    if (typeof fullParticipantsTotal === 'number') {
      setLastKnownParticipantsTotal({ chatId: chatId ?? null, total: fullParticipantsTotal });
    }
  }, [chatId, fullParticipantsTotal]);
  const profileHandoffMutation = useMutation({
    mutationFn: ({ userId, displayName }: { userId: string; displayName: string }) =>
      handoffChatMemberProfile(api, chatId ?? '', userId, { displayName }),
    onSuccess: (result) => {
      if (!activeView.current) return;
      if (!openMaxBotLinkAndClose(result.botUrl)) {
        pushToast({
          tone: 'danger',
          title: 'Не удалось открыть бота',
          description: 'Ссылка на профиль пустая.',
        });
      }
    },
    onError: (error: unknown) => {
      const description = normalizeLoadErrorMessage(error);
      pushToast({
        tone: 'danger',
        title: 'Не удалось открыть профиль',
        description,
      });
    },
    onSettled: () => {
      profileLock.current = false;
    },
  });
  const participantModerationMutation = useMutation({
    retry: false,
    mutationFn: ({
      chatId: actionChatId,
      userId,
      payload,
    }: {
      chatId: string;
      userId: string;
      payload: ManualModerationActionRequest;
    }) => applyManualModerationAction(api, actionChatId, userId, payload),
    onSuccess: (result, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['chat-sanctions', variables.chatId] });
      setPendingScopeAction((current) =>
        current?.source === 'participant' &&
        current.chatId === variables.chatId &&
        current.userId === variables.userId
          ? null
          : current,
      );
      if (
        selectedParticipant?.chatId === variables.chatId &&
        selectedParticipant.userId === variables.userId
      )
        setParticipantSavedVersion((value) => value + 1);
      void queryClient.invalidateQueries({
        queryKey: participantDetailsKey(variables.chatId, result.userId),
      });
      pushToast({
        tone: 'success',
        title: describeManualModerationFeedback(result),
      });
      if (variables.chatId !== chatId) return;
      void dashboardQuery.refetch();
      void participantsIdentityQuery.refetch();
      if (section === 'participants') void participantsFeed.retry();
    },
    onError: (error: unknown) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось применить',
        description: normalizeActionErrorMessage(error),
      });
    },
    onSettled: () => {
      scopeActionLock.current = false;
      setPendingScopeChoice(null);
    },
  });
  const cleanupUnavailableParticipantsMutation = useMutation({
    retry: false,
    mutationFn: () =>
      cleanupUnavailableChatParticipants(api, chatId ?? '', {
        dryRun: false,
      }),
    onSuccess: (result) => {
      setCleanupUnavailableConfirmOpen(false);
      pushToast({
        tone: result.failedCount > 0 ? 'danger' : 'success',
        title: result.message,
        description: `Проверено: ${result.scannedCount}. Найдено: ${result.matchedCount}.`,
      });
      void dashboardQuery.refetch();
      void participantsIdentityQuery.refetch();
      void participantsFeed.retry();
    },
    onError: (error: unknown) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось удалить',
        description: normalizeActionErrorMessage(error),
      });
    },
    onSettled: () => {
      cleanupLock.current = false;
    },
  });
  const spammerDiagnosticsBanMutation = useMutation({
    retry: false,
    mutationFn: ({ userId, scope }: { userId: string; scope: ManualModerationScopeChoice }) =>
      applyManualModerationAction(api, chatId ?? '', userId, { action: 'BAN', scope }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['chat-sanctions', chatId] });
      setPendingScopeAction((current) =>
        current?.source === 'spammer-diagnostics' ? null : current,
      );
      setSpammerDiagnosticsTarget(null);
      pushToast({
        tone: 'success',
        title: describeManualModerationFeedback(result),
      });
      void dashboardQuery.refetch();
      void moderationFeed.retry();
      void participantsFeed.retry();
      void queryClient.invalidateQueries({
        queryKey: queryKeys.globalSpammerUserDiagnostics(chatId, result.userId),
      });
    },
    onError: (error: unknown) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось заблокировать участника',
        description: normalizeActionErrorMessage(error),
      });
    },
    onSettled: () => {
      scopeActionLock.current = false;
      setPendingScopeChoice(null);
    },
  });
  const spammerReviewMutation = useMutation({
    mutationFn: ({
      userId,
      action,
      reason,
    }: {
      userId: string;
      action: GlobalSpammerReviewAction;
      reason?: string;
    }) =>
      reviewGlobalSpammerCandidate(api, chatId ?? '', userId, {
        action,
        ...(reason ? { reason } : {}),
      }),
    onMutate: async ({ userId }) => {
      const reviewedUserId = userId.trim();
      await queryClient.cancelQueries({ queryKey: spammerReviewQueueKey });
      const previousQueue =
        queryClient.getQueryData<Awaited<ReturnType<typeof getGlobalSpammerReviewQueue>>>(
          spammerReviewQueueKey,
        );
      queryClient.setQueryData(
        spammerReviewQueueKey,
        (current: Awaited<ReturnType<typeof getGlobalSpammerReviewQueue>> | undefined) =>
          current
            ? {
                ...current,
                items: current.items.filter((item) => item.userId !== reviewedUserId),
              }
            : current,
      );
      return { previousQueue };
    },
    onSuccess: (result) => {
      if (spammerDiagnosticsTarget?.userId === result.userId) {
        setSpammerDiagnosticsTarget(null);
      }
      pushToast({
        tone: 'success',
        title:
          result.status === 'SUPPRESSED' ? 'Не учитывается в спам-базе' : 'Подтверждён в спам-базе',
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.globalSpammerUserDiagnostics(chatId, result.userId),
      });
    },
    onError: (error: unknown, _variables, context) => {
      if (context?.previousQueue) {
        queryClient.setQueryData(spammerReviewQueueKey, context.previousQueue);
      }
      pushToast({
        tone: 'danger',
        title: 'Не удалось сохранить решение',
        description: normalizeActionErrorMessage(error),
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.globalSpammerReviewQueue(chatId),
      });
    },
  });
  const filterOptions = useMemo<
    Array<{ value: EventsFilter; label: string; count: number }>
  >(() => {
    const options: Array<{ value: EventsFilter; label: string; count: number }> = [
      { value: 'ALL', label: 'Все', count: violationsSummary.total },
      { value: 'WARN', label: 'Предупр.', count: violationsSummary.warn },
      {
        value: 'DELETE_MESSAGE',
        label: 'Удаления',
        count: violationsSummary.deleteMessage,
      },
      { value: 'MUTE', label: 'Мут', count: violationsSummary.mute },
      { value: 'BAN', label: 'Бан', count: violationsSummary.ban },
      { value: 'UNMUTE', label: 'Мут снят', count: violationsSummary.unmute },
      { value: 'UNBAN', label: 'Бан снят', count: violationsSummary.unban },
    ];

    return options;
  }, [dashboard]);
  const selectedEventFilter = filterOptions.find((option) => option.value === eventsFilter);

  useEffect(() => {
    setExpandedViolationId(null);
    setSpammerReviewOpen(false);
  }, [eventsFilter, range, section]);

  useEffect(() => {
    setParticipantTarget(null);
    setPendingScopeAction(null);
    setPendingScopeChoice(null);
    setSpammerDiagnosticsTarget(null);
  }, [chatId]);

  const openPendingScopeAction = (action: Omit<PendingScopeAction, 'chatId'>) => {
    setPendingScopeChoice(null);
    setPendingScopeAction({ ...action, chatId: chatId ?? '' });
  };
  const closePendingScopeAction = () => {
    if (
      scopeActionLock.current ||
      participantModerationMutation.isPending ||
      spammerDiagnosticsBanMutation.isPending
    ) {
      return;
    }
    setPendingScopeChoice(null);
    setPendingScopeAction(null);
  };
  const applyPendingScopeAction = (scope: ManualModerationScopeChoice) => {
    if (!pendingScopeAction || pendingScopeAction.chatId !== chatId || scopeActionLock.current) {
      return;
    }

    scopeActionLock.current = true;
    setPendingScopeChoice(scope);

    if (pendingScopeAction.source === 'spammer-diagnostics') {
      spammerDiagnosticsBanMutation.mutate({
        userId: pendingScopeAction.userId,
        scope,
      });
      return;
    }

    participantModerationMutation.mutate({
      chatId: pendingScopeAction.chatId,
      userId: pendingScopeAction.userId,
      payload: {
        action: pendingScopeAction.action,
        scope,
        ...(pendingScopeAction.action === 'MUTE'
          ? {
              muteDurationHours: clampMuteDurationHours(
                pendingScopeAction.muteDurationHours ?? MUTE_DURATION_MIN_HOURS,
              ),
            }
          : {}),
      },
    });
  };

  const selectedFilterCount = useMemo(
    () => filterOptions.find((option) => option.value === eventsFilter)?.count ?? 0,
    [eventsFilter, filterOptions],
  );
  const isModerationInitialLoading =
    moderationFeed.isReloading && moderationFeed.items.length === 0;
  const handleSectionChange = (nextSection: EventsSection) => {
    if (!chatId || nextSection === section) {
      return;
    }

    startTransition(() => {
      setSection(nextSection);
    });
    saveChatStatsPreference(location.state, chatId, { section: nextSection, range });
    navigate(
      {
        pathname: location.pathname,
        search: buildStatisticsRouteSearch(location.search, { section: nextSection, range }),
        hash: location.hash,
      },
      {
        replace: true,
        state: buildChatStatsRouteState(location.state, chatId, {
          section: nextSection,
          range,
        }),
      },
    );
  };
  const handleRangeChange = (nextRange: LogsDashboardRange) => {
    if (!chatId || nextRange === range) {
      return;
    }

    startTransition(() => {
      setRange(nextRange);
    });
    saveChatStatsPreference(location.state, chatId, { section, range: nextRange });
    navigate(
      {
        pathname: location.pathname,
        search: buildStatisticsRouteSearch(location.search, { section, range: nextRange }),
        hash: location.hash,
      },
      {
        replace: true,
        state: buildChatStatsRouteState(location.state, chatId, {
          section,
          range: nextRange,
        }),
      },
    );
  };
  const handleEventsFilterChange = (nextFilter: EventsFilter) => {
    if (nextFilter === eventsFilter) {
      return;
    }

    startTransition(() => {
      setEventsFilter(nextFilter);
    });
  };
  const handleSpammerDiagnosticsReview = (userId: string, action: GlobalSpammerReviewAction) => {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return;
    }

    spammerReviewMutation.mutate({
      userId: normalizedUserId,
      action,
    });
  };
  const handleSpammerDiagnosticsBan = (userId: string) => {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return;
    }

    openPendingScopeAction({
      id: `spammer-diagnostics-ban-${normalizedUserId}`,
      userId: normalizedUserId,
      action: 'BAN',
      source: 'spammer-diagnostics',
    });
  };
  const handleSpammerReviewRetry = () => {
    void spammerReviewQueueQuery.refetch();
  };
  const prefetchSpammerReviewQueue = () => {
    if (!chatId) {
      return;
    }
    void queryClient.prefetchQuery({
      queryKey: spammerReviewQueueKey,
      queryFn: ({ signal }) =>
        getGlobalSpammerReviewQueue(api, chatId, SPAMMER_REVIEW_QUEUE_QUERY, { signal }),
      staleTime: 60_000,
      gcTime: 10 * 60_000,
    });
  };
  const prefetchSpammerDiagnosticsShell = (target: SpammerDiagnosticsTarget) => {
    const targetUserId = target.userId.trim();
    if (!chatId || !targetUserId) {
      return;
    }
    void queryClient.prefetchQuery({
      queryKey: queryKeys.globalSpammerUserDiagnostics(
        chatId,
        targetUserId,
        SPAMMER_DIAGNOSTICS_LIGHT_SCOPE,
      ),
      queryFn: ({ signal }) =>
        getGlobalSpammerUserDiagnostics(
          api,
          chatId,
          targetUserId,
          SPAMMER_DIAGNOSTICS_LIGHT_QUERY,
          { signal },
        ),
      staleTime: 60_000,
      gcTime: 10 * 60_000,
    });
  };
  const openSpammerDiagnostics = (target: SpammerDiagnosticsTarget) => {
    if (!target.userId.trim()) {
      return;
    }
    prefetchSpammerDiagnosticsShell(target);
    setSpammerDiagnosticsTarget(target);
  };
  const handleSpammerCandidateDiagnostics = (candidate: GlobalSpammerReviewCandidate) => {
    setSpammerReviewOpen(false);
    openSpammerDiagnostics({
      userId: candidate.userId,
      displayName: resolveSpammerCandidateName(candidate),
      avatarUrl: candidate.avatarUrl ?? null,
      profileUrl: candidate.profileUrl ?? null,
      profileHandoffUrl: candidate.profileHandoffUrl ?? null,
    });
  };
  const handleActivityFilterChange = (nextFilter: Parameters<typeof activityFeed.setFilter>[0]) => {
    if (nextFilter === activityFeed.filter) {
      return;
    }

    startTransition(() => {
      activityFeed.setFilter(nextFilter);
    });
  };

  const hardMeasures = violationsSummary.mute + violationsSummary.ban;

  if (!chatId) {
    return (
      <div
        className="events-screen page-enter"
        data-managed-entity-workspace
        data-statistics-section={section}
      >
        <ManagedEntityWorkspaceHeader
          entityType="chat"
          screen="stats"
          title={chatTitle}
          backTo={buildManagedEntitiesRoute('chat')}
          counterpartTo={buildManagedEntitiesRoute('chat')}
          counterpartHidden
          className="events-stage__workspace-header"
        />
        <GlassCard>
          <StatusState
            tone="warning"
            title="Чат не выбран"
            description="Выберите чат в разделе «Чаты»."
            action={
              <Link to={buildManagedEntitiesRoute('chat')} className="button button--accent">
                К списку чатов
              </Link>
            }
          />
        </GlassCard>
      </div>
    );
  }

  const activityBalanceTone =
    membershipSummary.netUsers > 0
      ? 'success'
      : membershipSummary.netUsers < 0
        ? 'danger'
        : 'neutral';
  const movementShares = resolveMembershipMovementShares(
    membershipSummary.joinedUsers,
    membershipSummary.leftUsers,
  );
  const joinedShare = movementShares.joined;
  const leftShare = movementShares.left;
  const activityBalanceLabel =
    membershipSummary.netUsers > 0
      ? 'Прирост участников'
      : membershipSummary.netUsers < 0
        ? 'Отток участников'
        : 'Баланс без изменений';
  const participantsTotal =
    fullParticipantsTotal ??
    (lastKnownParticipantsTotal?.chatId === (chatId ?? null)
      ? lastKnownParticipantsTotal.total
      : null);
  const participantsTotalPresentation = resolveNullableMetricPresentation(
    participantsTotal,
    participantsFeed.isReloading,
  );
  const moderationSecondaryMetrics = [
    {
      label: 'Участников',
      value: String(violationsSummary.affectedUsers),
      note: '',
      tone: 'neutral' as const,
    },
    {
      label: 'Ограничения',
      value: String(hardMeasures),
      note: '',
      tone: hardMeasures > 0 ? ('danger' as const) : ('neutral' as const),
    },
  ];
  const activateProfile = (userId: string, displayName: string) => {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId || !chatId || profileLock.current || profileHandoffMutation.isPending) {
      return;
    }

    const normalizedDisplayName = displayName.trim() || 'Пользователь';
    profileLock.current = true;
    // FLAG: Persist the name before opening MAX; bot_started can otherwise win this race.
    profileHandoffMutation.mutate({
      userId: normalizedUserId,
      displayName: normalizedDisplayName,
    });
  };
  const isAppbarBusy =
    dashboardQuery.isFetching ||
    participantsIdentityQuery.isFetching ||
    (section === 'participants' &&
      (participantsFeed.isReloading || participantsFeed.isLoadingMore));

  return (
    <div
      className="events-screen page-enter"
      data-managed-entity-workspace
      data-statistics-section={section}
    >
      <ManagedEntityWorkspaceHeader
        entityType="chat"
        screen="stats"
        title={chatTitle}
        avatarUrl={chatAvatarUrl}
        authoritativeIdentity={
          authoritativeChatIdentity
            ? {
                title:
                  chatTitleResolution.source === 'remote' ? authoritativeChatIdentity.title : null,
                avatarUrl: authoritativeChatIdentity.avatarUrl ?? null,
              }
            : undefined
        }
        backTo={buildManagedEntitiesRoute('chat')}
        counterpartTo={buildManagedEntitySettingsRoute('chat', chatId)}
        compact
        busy={isAppbarBusy}
        status={
          section !== 'participants' && !isSanctionsView ? (
            <button
              type="button"
              className="managed-entity-workspace-header__counterpart"
              aria-label="Обновить события"
              title="Обновить события"
              disabled={isAppbarBusy || activityFeed.isReloading || moderationFeed.isReloading}
              onClick={() => {
                void dashboardQuery.refetch();
                void (section === 'activity' ? activityFeed : moderationFeed).retry();
              }}
            >
              <IconoirSprite variant="iconoir" icon="Refresh" width={20} height={20} aria-hidden />
            </button>
          ) : null
        }
        className="events-stage__workspace-header"
      />

      <div
        className={`events-primary-tabs${expandedText ? ' is-expanded-text' : ''}`}
        role="group"
        aria-label="Раздел статистики"
      >
        <div ref={sectionTabsRef} className="events-primary-tabs__track">
          <button
            type="button"
            aria-pressed={section === 'moderation'}
            className={`events-primary-tab ${section === 'moderation' ? 'is-active' : ''}`}
            onClick={() => handleSectionChange('moderation')}
          >
            <span className="events-primary-tab__icon" aria-hidden="true">
              <ModerationTabIcon />
            </span>
            <span className="events-primary-tab__label">Модерация</span>
          </button>

          <button
            type="button"
            aria-pressed={section === 'participants'}
            className={`events-primary-tab ${section === 'participants' ? 'is-active' : ''}`}
            onClick={() => handleSectionChange('participants')}
          >
            <span className="events-primary-tab__icon" aria-hidden="true">
              <ParticipantsTabIcon />
            </span>
            <span className="events-primary-tab__label">Участники</span>
          </button>

          <button
            type="button"
            aria-pressed={section === 'activity'}
            className={`events-primary-tab ${section === 'activity' ? 'is-active' : ''}`}
            onClick={() => handleSectionChange('activity')}
          >
            <span className="events-primary-tab__icon" aria-hidden="true">
              <ActivityTabIcon />
            </span>
            <span className="events-primary-tab__label">События</span>
          </button>
        </div>
      </div>

      {section === 'moderation' ? (
        <SegmentedControl
          value={moderationView}
          options={[
            { value: 'sanctions', label: 'Ограничения' },
            { value: 'history', label: 'Журнал' },
          ]}
          onChange={(value) => changeModerationView(value as 'sanctions' | 'history')}
          ariaLabel="Режим модерации"
          className="events-moderation-view"
        />
      ) : null}

      {section === 'activity' && dashboard && dashboardQuery.error ? (
        <div className="events-refresh-error" role="status">
          <span>Сводка не обновлена. {normalizeLoadErrorMessage(dashboardQuery.error)}</span>
          <button
            type="button"
            className="button button--ghost"
            disabled={dashboardQuery.isFetching}
            onClick={() => void dashboardQuery.refetch()}
          >
            Повторить
          </button>
        </div>
      ) : null}

      {isSanctionsView ? (
        <Suspense fallback={<Spinner size="lg" label="Загружаем ограничения" />}>
          <ChatSanctionsWorkspace
            key={`${chatId}:${sanctionsUserId ?? ''}`}
            api={api}
            chatId={chatId}
            chatTitle={chatTitle}
            initialUserId={sanctionsUserId}
            describeReason={(item) =>
              resolveModerationFeedReason({
                ruleCode: item.ruleCode,
                metadata: { reason: item.reason },
              })
            }
            onRelease={async (item) => {
              if (!item.releaseAction)
                throw new Error('Состояние ограничения изменилось. Обновите список.');
              return describeManualModerationFeedback(
                await applyManualModerationAction(api, chatId, item.userId, {
                  action: item.releaseAction,
                  expectedSanctionEventId: item.id,
                }),
              );
            }}
            onProfileActivate={activateProfile}
            onParticipantActivate={(item) =>
              setParticipantTarget({
                chatId,
                userId: item.userId,
                userDisplayName: item.userDisplayName,
                avatarUrl: item.avatarUrl,
                origin: {
                  title: item.action === 'BAN' ? 'Бан' : 'Мут',
                  date: item.createdAt,
                  reason: item.reason,
                },
              })
            }
            isOpeningProfile={profileHandoffMutation.isPending}
            onChanged={() => {
              void participantsFeed.retry();
              void participantsIdentityQuery.refetch();
              void queryClient.invalidateQueries({ queryKey: ['logs-dashboard'] });
            }}
          />
        </Suspense>
      ) : (
        <section className={`events-stage events-stage--${section}`}>
          <div className="events-stage__panel stagger-in">
            <section
              className={`events-dashboard events-dashboard--${section}`}
              aria-label={
                section === 'activity'
                  ? 'Сводка по событиям'
                  : section === 'participants'
                    ? 'Сводка по участникам'
                    : 'Сводка по модерации'
              }
            >
              {section === 'participants' ? (
                <div className="events-dashboard__body events-dashboard__body--participants">
                  <article className="events-dashboard__hero events-dashboard__hero--accent">
                    <small aria-label="Всего участников">Всего</small>
                    <strong className="events-dashboard__hero-value">
                      {participantsTotalPresentation.status === 'loading' ? (
                        <span
                          className="events-dashboard__hero-spinner"
                          role="status"
                          aria-label="Загружаем количество участников"
                        />
                      ) : (
                        <span
                          className="events-dashboard__hero-number"
                          aria-label={
                            participantsTotalPresentation.status === 'unavailable'
                              ? 'Количество участников недоступно'
                              : undefined
                          }
                        >
                          {participantsTotalPresentation.value}
                        </span>
                      )}
                    </strong>
                  </article>
                </div>
              ) : null}
              <div className="events-dashboard__head">
                <span className="events-dashboard__period-label">
                  {section === 'participants'
                    ? 'Нарушения'
                    : section === 'activity'
                      ? 'Движение участников'
                      : 'Действия за период'}
                </span>
                <SegmentedControl
                  value={range}
                  options={periodOptions}
                  onChange={(next) => handleRangeChange(next as LogsDashboardRange)}
                  className="events-dashboard__range"
                  ariaLabel={
                    section === 'participants' ? 'Период подсчёта нарушений' : 'Период статистики'
                  }
                />
              </div>

              {section !== 'participants' && isDashboardPending ? (
                <EventsDashboardSkeleton section={section} />
              ) : section !== 'participants' && hasBlockingDashboardError ? (
                <GlassCard className="events-inline-state">
                  <StatusState
                    tone="danger"
                    title="Не удалось загрузить статистику"
                    description={normalizeLoadErrorMessage(dashboardQuery.error)}
                    action={
                      <button
                        type="button"
                        className="button button--danger"
                        onClick={() => void dashboardQuery.refetch()}
                      >
                        Повторить
                      </button>
                    }
                  />
                </GlassCard>
              ) : section === 'participants' ? null : section === 'activity' ? (
                <div className="events-dashboard__activity">
                  <article
                    className={`events-dashboard__activity-balance events-dashboard__activity-balance--${activityBalanceTone}`}
                  >
                    <small>Баланс</small>
                    <strong>{formatSignedCount(membershipSummary.netUsers)}</strong>
                    <span>{activityBalanceLabel}</span>
                  </article>

                  <div className="events-dashboard__activity-ledger">
                    <article className="events-dashboard__flow-card events-dashboard__flow-card--joined">
                      <small>Вошли</small>
                      <strong>{membershipSummary.joinedUsers}</strong>
                      <span>
                        {movementShares.hasMovement ? `${joinedShare}% движения` : 'Нет событий'}
                      </span>
                    </article>

                    <article className="events-dashboard__flow-card events-dashboard__flow-card--left">
                      <small>Вышли</small>
                      <strong>{membershipSummary.leftUsers}</strong>
                      <span>
                        {movementShares.hasMovement ? `${leftShare}% движения` : 'Нет событий'}
                      </span>
                    </article>

                    <div
                      className={`events-dashboard__flow-bar ${
                        movementShares.hasMovement ? '' : 'is-empty'
                      }`.trim()}
                      aria-hidden="true"
                    >
                      <span style={{ width: `${joinedShare}%` }} />
                    </div>

                    <div className="events-dashboard__flow-meta">
                      <small>
                        {movementShares.hasMovement ? `Вошли ${joinedShare}%` : 'Движения нет'}
                      </small>
                      {movementShares.hasMovement ? <small>Вышли {leftShare}%</small> : null}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="events-dashboard__body events-dashboard__body--moderation">
                  <article className="events-dashboard__hero events-dashboard__hero--accent">
                    <small>Действия</small>
                    <strong>{violationsSummary.total}</strong>
                    <div className="events-dashboard__composition" aria-hidden="true">
                      {filterOptions
                        .slice(1)
                        .map((item) =>
                          item.count > 0 ? (
                            <span
                              key={item.value}
                              data-action={item.value}
                              style={{ flexGrow: item.count }}
                            />
                          ) : null,
                        )}
                    </div>
                  </article>

                  <div className="events-dashboard__stack">
                    {moderationSecondaryMetrics.map((item) => (
                      <article
                        key={item.label}
                        className={`events-dashboard__metric events-dashboard__metric--${item.tone}`}
                      >
                        <small>{item.label}</small>
                        <strong>{item.value}</strong>
                        {item.note ? <span>{item.note}</span> : null}
                      </article>
                    ))}
                  </div>
                </div>
              )}
            </section>

            {section === 'moderation' && dashboard ? (
              <label className="events-filter-menu">
                <span>Тип события</span>
                <span className="events-filter-menu__control">
                  <span className="events-filter-menu__value" aria-hidden="true">
                    {selectedEventFilter?.label} · {selectedEventFilter?.count}
                  </span>
                  <select
                    aria-label="Тип события"
                    value={eventsFilter}
                    onChange={(event) =>
                      handleEventsFilterChange(event.target.value as EventsFilter)
                    }
                  >
                    {filterOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label} · {dashboard ? option.count : '...'}
                      </option>
                    ))}
                  </select>
                </span>
              </label>
            ) : null}
          </div>
        </section>
      )}

      {section === 'activity' ? (
        <Suspense fallback={<Spinner size="lg" label="Загружаем события" />}>
          <MembershipActivityFeed
            joinedLabel="чату"
            leftLabel="чат"
            resetKey={`${chatId ?? ''}:${range}`}
            variant="immersive"
            filter={activityFeed.filter}
            onFilterChange={handleActivityFilterChange}
            items={activityFeed.items}
            hasMore={activityFeed.hasMore}
            isReloading={activityFeed.isReloading}
            isLoadingMore={activityFeed.isLoadingMore}
            error={activityFeed.error}
            onLoadMore={() => void activityFeed.loadMore()}
            onRetry={() => void activityFeed.retryFailed()}
            onParticipantActivate={(item: MembershipActivityItem) =>
              setParticipantTarget({
                chatId,
                userId: item.userId,
                userDisplayName: item.userDisplayName,
                avatarUrl: item.avatarUrl,
                origin: {
                  title: item.type === 'joined' ? 'Вход в чат' : 'Выход из чата',
                  date: item.createdAt,
                },
              })
            }
          />
        </Suspense>
      ) : null}

      {section === 'participants' ? (
        <Suspense fallback={<Spinner size="lg" label="Загружаем участников" />}>
          <ChatParticipantsRoster
            resetKey={`${chatId}:${range}`}
            items={participantsFeed.items}
            search={participantsSearch}
            rangeLabel={formatStatisticsRangeLabel(range)}
            roleFilter={participantsRoleFilter}
            onRoleFilterChange={setParticipantsRoleFilter}
            activityFilter={participantsActivityFilter}
            onActivityFilterChange={setParticipantsActivityFilter}
            hasMore={participantsFeed.hasMore}
            isReloading={participantsFeed.isReloading}
            isLoadingMore={participantsFeed.isLoadingMore}
            isSearchPending={participantsSearch.trim() !== debouncedParticipantsSearch}
            updatedAt={participantsFeed.updatedAt}
            error={
              participantsFeed.error ? normalizeLoadErrorMessage(participantsFeed.error) : null
            }
            onSearchChange={setParticipantsSearch}
            onLoadMore={() => void participantsFeed.loadMore()}
            onRetry={() => void participantsFeed.retryFailed()}
            onRefresh={() => {
              void participantsFeed.retry();
              void participantsIdentityQuery.refetch();
            }}
            onParticipantActivate={(item: ChatParticipantItem) =>
              setParticipantTarget({ ...item, chatId })
            }
            onCleanupUnavailable={() => setCleanupUnavailableConfirmOpen(true)}
            isCleanupUnavailableBusy={cleanupUnavailableParticipantsMutation.isPending}
          />
        </Suspense>
      ) : null}

      {section === 'moderation' && !isSanctionsView ? (
        <>
          <GlobalSpammerReviewPanel
            candidates={spammerReviewQueueQuery.data?.items ?? []}
            isLoading={spammerReviewQueueQuery.isLoading && !spammerReviewQueueQuery.data}
            error={spammerReviewQueueQuery.error}
            onOpen={() => setSpammerReviewOpen(true)}
            onWarm={prefetchSpammerReviewQueue}
          />

          {dashboardQuery.error && dashboard ? (
            <GlassCard className="events-inline-state">
              <StatusState
                tone="warning"
                title="Данные могли устареть"
                description={normalizeLoadErrorMessage(dashboardQuery.error)}
                action={
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => void dashboardQuery.refetch()}
                  >
                    Обновить
                  </button>
                }
              />
            </GlassCard>
          ) : null}

          {dashboard &&
          violationsSummary.total === 0 &&
          moderationFeed.items.length === 0 &&
          !moderationFeed.isReloading &&
          !moderationFeed.error ? (
            <GlassCard className="events-inline-state">
              <StatusState
                tone="neutral"
                title="Нарушений не найдено"
                description="За выбранный период действий модерации и ручных возвратов не было."
              />
            </GlassCard>
          ) : null}

          {dashboard &&
          violationsSummary.total > 0 &&
          selectedFilterCount === 0 &&
          moderationFeed.items.length === 0 &&
          !moderationFeed.isReloading &&
          !moderationFeed.error ? (
            <GlassCard className="events-inline-state">
              <StatusState
                tone="neutral"
                title="По этому фильтру ничего не найдено"
                description="Попробуйте переключить тип события или расширить период."
              />
            </GlassCard>
          ) : null}

          {moderationFeed.error ? (
            <GlassCard className="events-inline-state">
              <StatusState
                tone="warning"
                title="Не удалось загрузить список"
                description={normalizeLoadErrorMessage(moderationFeed.error)}
                action={
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => void moderationFeed.retryFailed()}
                  >
                    Повторить
                  </button>
                }
              />
            </GlassCard>
          ) : null}

          {isModerationInitialLoading ? (
            <GlassCard className="events-inline-state">
              <div className="events-loading-state">
                <Spinner size="lg" label="Загружаем список событий модерации" />
              </div>
            </GlassCard>
          ) : null}

          {moderationFeed.items.length > 0 ? (
            <>
              <section className="events-feed" aria-label="Список нарушений">
                {moderationFeed.items.map((violation) => {
                  const displayAction = resolveDisplayAction(violation);
                  const isExpanded = expandedViolationId === violation.id;
                  const displayName = resolveOffenderName(violation);
                  const avatarUrl = resolveOffenderAvatarUrl(violation);
                  const violationReason = resolveModerationFeedReason(violation);
                  const profileHandoffUrl = violation.profileHandoffUrl?.trim() ?? '';
                  const profileUrl = violation.profileUrl?.trim() ?? '';
                  const canOpenParticipant = violation.userId.trim().length > 0;
                  const openParticipant = () =>
                    setParticipantTarget({
                      chatId,
                      userId: violation.userId,
                      userDisplayName: displayName,
                      avatarUrl,
                      profileUrl,
                      profileHandoffUrl,
                      origin: {
                        title: actionLabelMap[displayAction],
                        date: violation.createdAt,
                        reason: violationReason || resolveViolationBlurb(violation),
                      },
                    });
                  const toggleExpanded = () =>
                    setExpandedViolationId((current) =>
                      current === violation.id ? null : violation.id,
                    );

                  return (
                    <article
                      key={violation.id}
                      className={`event-feed-item event-feed-item--${actionToneMap[displayAction]} ${
                        isExpanded ? 'is-expanded' : ''
                      }`}
                    >
                      <div className="event-feed-item__trigger">
                        {canOpenParticipant ? (
                          <button
                            type="button"
                            className="event-feed-item__avatar-link"
                            aria-label={`Открыть участника ${displayName}`}
                            onClick={openParticipant}
                          >
                            <PersonAvatar
                              avatarUrl={avatarUrl}
                              fallback={resolveOffenderInitial(displayName)}
                              className="event-feed-item__avatar"
                            />
                          </button>
                        ) : (
                          <PersonAvatar
                            avatarUrl={avatarUrl}
                            fallback={resolveOffenderInitial(displayName)}
                            className="event-feed-item__avatar"
                          />
                        )}

                        <div className="event-feed-item__main">
                          <button
                            type="button"
                            className="event-feed-item__person"
                            disabled={!canOpenParticipant}
                            onClick={openParticipant}
                            aria-label={`Открыть участника ${displayName}`}
                          >
                            <strong>{displayName}</strong>
                            <IconoirSprite
                              variant="iconoir"
                              icon="NavArrowRight"
                              width={16}
                              height={16}
                              aria-hidden
                            />
                          </button>
                          <button
                            type="button"
                            className="event-feed-item__expand"
                            onClick={toggleExpanded}
                            aria-expanded={isExpanded}
                            aria-controls={`event-details-${violation.id}`}
                            aria-label={`${isExpanded ? 'Скрыть' : 'Показать'} детали нарушения: ${displayName}`}
                          >
                            <span className="event-feed-item__body">
                              <span className="event-feed-item__headline">
                                <span className="event-feed-item__identity">
                                  <span className="event-feed-item__stamp">
                                    <span
                                      className={`event-feed-item__action event-feed-item__action--${actionToneMap[displayAction]}`}
                                    >
                                      {actionLabelMap[displayAction]}
                                    </span>
                                    <time dateTime={violation.createdAt}>
                                      {formatViolationDate(violation.createdAt)}
                                    </time>
                                  </span>
                                </span>

                                <span className="event-feed-item__toggle" aria-hidden="true">
                                  <IconoirSprite
                                    variant="iconoir"
                                    icon="NavArrowDown"
                                    width={18}
                                    height={18}
                                    strokeWidth={2.2}
                                  />
                                </span>
                              </span>

                              <span className="event-feed-item__summary">
                                {violationReason || resolveViolationBlurb(violation)}
                              </span>
                            </span>
                          </button>
                        </div>
                      </div>

                      {isExpanded ? (
                        <div
                          id={`event-details-${violation.id}`}
                          className="event-feed-item__details"
                        >
                          <div className="event-feed-item__reason">
                            <span>Причина</span>
                            <p>{violationReason || resolveViolationBlurb(violation)}</p>
                          </div>

                          {violation.maskedExcerpt ? (
                            <div className="event-feed-item__excerpt">
                              <span>Фрагмент сообщения</span>
                              <p>{violation.maskedExcerpt}</p>
                            </div>
                          ) : null}

                          <ViolationModerationControls
                            api={api}
                            chatId={chatId}
                            violation={violation}
                            onOpenDiagnostics={() =>
                              openSpammerDiagnostics({
                                userId: violation.userId,
                                displayName,
                                avatarUrl,
                                profileUrl,
                                profileHandoffUrl,
                              })
                            }
                            onApplied={() => {
                              void queryClient.invalidateQueries({
                                queryKey: ['chat-sanctions', chatId],
                              });
                              void dashboardQuery.refetch();
                              void moderationFeed.retry();
                            }}
                          />
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </section>

              {moderationFeed.hasMore ? (
                <button
                  type="button"
                  className="button button--ghost membership-feed__load-more"
                  onClick={() => void moderationFeed.loadMore()}
                  disabled={moderationFeed.isLoadingMore || moderationFeed.isReloading}
                >
                  {moderationFeed.isLoadingMore ? 'Загружаем...' : 'Показать ещё'}
                </button>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}

      <SpammerReviewSheet
        open={spammerReviewOpen}
        candidates={spammerReviewQueueQuery.data?.items ?? []}
        isLoading={spammerReviewQueueQuery.isLoading && !spammerReviewQueueQuery.data}
        isRefreshing={spammerReviewQueueQuery.isFetching && Boolean(spammerReviewQueueQuery.data)}
        error={spammerReviewQueueQuery.error}
        onClose={() => setSpammerReviewOpen(false)}
        onRetry={handleSpammerReviewRetry}
        onOpenDiagnostics={handleSpammerCandidateDiagnostics}
        onWarmDiagnostics={(candidate) =>
          prefetchSpammerDiagnosticsShell({
            userId: candidate.userId,
            displayName: resolveSpammerCandidateName(candidate),
            avatarUrl: candidate.avatarUrl ?? null,
            profileUrl: candidate.profileUrl ?? null,
            profileHandoffUrl: candidate.profileHandoffUrl ?? null,
          })
        }
      />

      <SpammerDiagnosticsSheet
        open={Boolean(spammerDiagnosticsTarget)}
        target={spammerDiagnosticsTarget}
        diagnostics={spammerDiagnostics}
        isLoading={isSpammerDiagnosticsLoading}
        isLoadingDetails={isSpammerDiagnosticsLoadingDetails}
        isRefreshing={isSpammerDiagnosticsRefreshing}
        error={spammerDiagnosticsError}
        reviewingAction={
          spammerReviewMutation.isPending &&
          spammerReviewMutation.variables?.userId === spammerDiagnosticsTarget?.userId
            ? (spammerReviewMutation.variables.action ?? null)
            : null
        }
        isBanning={
          spammerDiagnosticsBanMutation.isPending &&
          spammerDiagnosticsBanMutation.variables?.userId === spammerDiagnosticsTarget?.userId
        }
        onClose={() => setSpammerDiagnosticsTarget(null)}
        onRetry={() => {
          if (spammerDiagnosticsUserId) {
            setSpammerDiagnosticsFullEnabledFor(spammerDiagnosticsUserId);
          }
          void spammerDiagnosticsLightQuery.refetch();
          void spammerDiagnosticsFullQuery.refetch();
        }}
        onReview={handleSpammerDiagnosticsReview}
        onBan={handleSpammerDiagnosticsBan}
        onProfileActivate={activateProfile}
      />

      <ActionConfirmSheet
        id={pendingScopeAction?.id ?? 'manual-moderation-scope'}
        open={Boolean(pendingScopeAction && pendingScopeAction.chatId === chatId)}
        title={pendingScopeAction?.action === 'BAN' ? 'Бан участника' : 'Мут участника'}
        summary={
          pendingScopeAction?.source === 'participant'
            ? selectedParticipant?.userDisplayName
            : spammerDiagnosticsTarget?.displayName
        }
        previewMeta={
          pendingScopeAction?.action === 'MUTE'
            ? `Срок: ${pendingScopeAction.muteDurationHours ?? 24} ч`
            : undefined
        }
        previewTitle={
          pendingScopeAction?.action === 'BAN'
            ? pendingScopeAction.banOnRejoin
              ? 'При возвращении участник будет удалён.'
              : 'Участник будет удалён из выбранных чатов.'
            : 'Новые сообщения будут удаляться до конца срока мута.'
        }
        confirmLabel="В этом чате"
        confirmBusyLabel="Применяем..."
        cancelLabel="Отмена"
        tone={pendingScopeAction?.action === 'BAN' ? 'danger' : 'accent'}
        isBusy={participantModerationMutation.isPending || spammerDiagnosticsBanMutation.isPending}
        confirmBusy={
          (participantModerationMutation.isPending || spammerDiagnosticsBanMutation.isPending) &&
          pendingScopeChoice === 'current_chat'
        }
        extraActionLabel="Во всех чатах"
        extraActionBusyLabel="Применяем..."
        extraActionBusy={
          (participantModerationMutation.isPending || spammerDiagnosticsBanMutation.isPending) &&
          pendingScopeChoice === 'all_chats'
        }
        extraActionTone={pendingScopeAction?.action === 'BAN' ? 'danger' : 'accent'}
        actionOrder="confirm-extra-cancel"
        onExtraAction={() => applyPendingScopeAction('all_chats')}
        onClose={closePendingScopeAction}
        onConfirm={() => applyPendingScopeAction('current_chat')}
      />

      <ActionConfirmSheet
        id="cleanup-unavailable-participants"
        open={cleanupUnavailableConfirmOpen}
        title="Удалить заблокированные аккаунты?"
        summary="Будут удалены только участники, которых MAX явно пометил как удалённые, заблокированные или отключённые аккаунты."
        previewTitle="Обычные участники, админы, владельцы и боты пропускаются."
        previewMeta="Перед удалением бот ещё раз проверит состояние каждого аккаунта."
        confirmLabel="Удалить"
        confirmBusyLabel="Проверяем..."
        cancelLabel="Отмена"
        tone="danger"
        isBusy={cleanupUnavailableParticipantsMutation.isPending}
        onClose={() => {
          if (cleanupLock.current || cleanupUnavailableParticipantsMutation.isPending) {
            return;
          }
          setCleanupUnavailableConfirmOpen(false);
        }}
        onConfirm={() => {
          if (cleanupLock.current) return;
          cleanupLock.current = true;
          cleanupUnavailableParticipantsMutation.mutate();
        }}
      />

      {selectedParticipant ? (
        <Suspense
          fallback={
            <SettingsDrilldownPanel
              id="participant-sheet-loading"
              open
              title={selectedParticipant.userDisplayName}
              onClose={() => setParticipantTarget(null)}
            >
              <Spinner size="lg" label="Загружаем карточку участника" />
            </SettingsDrilldownPanel>
          }
        >
          <ChatParticipantCard
            key={`${chatId}:${selectedParticipant.userId}`}
            api={api}
            target={selectedParticipant}
            range={range}
            chatTitle={chatTitle}
            savedVersion={participantSavedVersion}
            onSanctionsChanged={() => {
              void dashboardQuery.refetch();
              if (section === 'moderation' && !isSanctionsView) void moderationFeed.retry();
            }}
            describeReason={(item) =>
              resolveModerationFeedReason({
                ruleCode: item.ruleCode,
                metadata: { reason: item.reason },
              })
            }
            onRelease={async (item) => {
              if (!item.releaseAction)
                throw new Error('Состояние ограничения изменилось. Обновите список.');
              return describeManualModerationFeedback(
                await applyManualModerationAction(api, chatId, item.userId, {
                  action: item.releaseAction,
                  expectedSanctionEventId: item.id,
                }),
              );
            }}
            open={Boolean(selectedParticipant)}
            rangeLabel={formatStatisticsRangeLabel(range)}
            onImmunityChanged={() => {
              if (section === 'participants') void participantsFeed.retry();
            }}
            isApplyingModeration={participantModerationMutation.isPending}
            isOpeningProfile={profileHandoffMutation.isPending}
            onClose={() => setParticipantTarget(null)}
            onProfileActivate={() => {
              if (!selectedParticipant) {
                return;
              }

              activateProfile(selectedParticipant.userId, selectedParticipant.userDisplayName);
            }}
            onSpammerDiagnostics={() => {
              if (!selectedParticipant) {
                return;
              }

              openSpammerDiagnostics({
                userId: selectedParticipant.userId,
                displayName:
                  selectedParticipant.userDisplayName || selectedParticipant.username || '',
                avatarUrl: selectedParticipant.avatarUrl,
                profileUrl: selectedParticipant.profileUrl,
                profileHandoffUrl: selectedParticipant.profileHandoffUrl,
              });
            }}
            onMute={(durationHours) => {
              if (!selectedParticipant) {
                return;
              }

              openPendingScopeAction({
                id: `participant-mute-${selectedParticipant.userId}`,
                userId: selectedParticipant.userId,
                action: 'MUTE',
                source: 'participant',
                muteDurationHours: clampMuteDurationHours(durationHours),
              });
            }}
            onBan={(banOnRejoin) => {
              if (!selectedParticipant) {
                return;
              }

              openPendingScopeAction({
                id: `participant-ban-${selectedParticipant.userId}`,
                userId: selectedParticipant.userId,
                action: 'BAN',
                source: 'participant',
                banOnRejoin,
              });
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
