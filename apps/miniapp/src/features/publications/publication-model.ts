import type {
  BroadcastImage,
  BroadcastLinkButton,
  BroadcastTextFormat,
  ChannelPostSignatureSettings,
  ChannelOverview,
  ChatSummary,
  ManagedEntityType,
} from '@maxim/contracts';
import {
  MAX_PUBLICATION_EXPLICIT_SLOTS,
  DEFAULT_PUBLICATION_LATE_POLICY,
  type PublicationLatePolicy,
  MAX_PUBLICATION_TEXT_LENGTH,
  publicationPostPublishSchema,
  type PublicationPostPublish,
  type CreatePublicationRequest,
  type PublicationAsset,
  type PublicationContentInput,
  type PublicationDeliveryStats,
  type PublicationDetails,
  type PublicationDispatchIssue,
  type PublicationLifecycle,
  type PublicationOccurrenceSummary,
  type PublicationScheduleInput,
  type PublicationSummary,
  type TestPublicationRequest,
  type UpdatePublicationRequest,
} from '@maxim/contracts/publication';
import type { PublisherEntityReadiness } from '@maxim/contracts/publisher';
import { trimBroadcastLinkButtons } from '../../lib/broadcast-link-buttons';
import {
  resolveBroadcastScheduleTimezone,
  sortAndUniqueBroadcastSlots,
} from '../../lib/broadcast-schedule';
import { formatPublicationScheduleField } from './publication-time-presentation';
import {
  buildChannelBroadcastSystemButtons,
  type BroadcastSystemButtonPreview,
} from '../../lib/broadcast-system-buttons';
import {
  formatPublicationDeliveryError,
  PUBLICATION_DELIVERY_ERROR_FALLBACK,
} from './publication-delivery-error';

export type PublicationView = 'current' | 'schedules' | 'history';
export type PublicationRetainedAsset = PublicationAsset & { sourcePublicationId?: string };

export type PublicationEditorKind = 'create' | 'edit' | 'duplicate' | 'import' | 'draft';
export type PublicationEditorContext =
  | { kind: 'create' }
  | {
      kind: 'edit';
      publicationId: string;
      expectedRevision: number;
      editScope: PublicationEditScope | null;
    }
  | { kind: 'duplicate' }
  | { kind: 'draft'; publicationId: string; expectedRevision: number }
  | {
      kind: 'import';
      publicationId: string;
      expectedRevision: number;
      sessionId: string | null;
    };
export type PublicationTimingMode = 'now' | 'once' | 'schedule';

export function getPublicationPrimaryActionLabel(options: {
  hasValidationIssues: boolean;
  editing: boolean;
  timingMode: PublicationTimingMode;
}): string {
  if (options.hasValidationIssues) {
    return 'Проверить';
  }
  if (options.editing) {
    return 'Сохранить';
  }
  if (options.timingMode === 'now') {
    return 'Опубликовать';
  }
  return options.timingMode === 'once' ? 'Запланировать' : 'Сохранить расписание';
}
export type PublicationScheduleKind = 'slots' | 'recurrence';
export type PublicationRecurrenceFrequency = 'daily' | 'weekly';
export type PublicationEntityFilter = 'all' | ManagedEntityType;
export type PublicationStatusFilter = 'all' | 'active' | 'paused' | 'completed' | 'failed';

type PublicationPollingItem = Pick<
  PublicationSummary,
  'lifecycle' | 'delivery' | 'actionableDelivery'
> & {
  dispatchIssue?: PublicationSummary['dispatchIssue'];
  schedule: {
    mode: 'now' | 'once' | 'slots' | 'recurrence';
    nextOccurrenceAt: string | null;
    status?: NonNullable<PublicationSummary['schedule']>['status'];
  } | null;
};

export type PublicationSaveFeedback = {
  tone: 'success' | 'info' | 'danger';
  title: string;
  description?: string;
  notification: 'success' | 'warning' | 'error';
};

export type PublicationEditScope = 'future' | 'retry' | 'schedule';

export type PublicationActionCapabilities = {
  canCancel: boolean;
  canEdit: boolean;
  canPause: boolean;
  canResume: boolean;
  canRetry: boolean;
  editScope: PublicationEditScope | null;
  hasFutureSends: boolean;
};

export function getPublicationLifecycleLabel(lifecycle: PublicationLifecycle): string {
  const labels: Record<PublicationLifecycle, string> = {
    DRAFT: 'Черновик',
    ACTIVE: 'Активно',
    PAUSED: 'Пауза',
    COMPLETED: 'Готово',
    CANCELED: 'Отменено',
    ERROR: 'Ошибка',
  };
  return labels[lifecycle];
}

export type PublicationDispatchIssuePresentation = {
  canRecheck: boolean;
  description: string;
  label: string;
  title: string;
};

export const PUBLICATION_DISPATCH_ISSUE_POLL_INTERVAL_MS = 30_000;

export function hasPublicationScheduleError(
  publication: Pick<PublicationSummary, 'lifecycle' | 'schedule'>,
): boolean {
  return (
    (publication.lifecycle === 'ACTIVE' || publication.lifecycle === 'ERROR') &&
    publication.schedule?.status === 'ERROR'
  );
}

export function getPublicationScheduleErrorPresentation(
  publication: Pick<PublicationSummary, 'lifecycle' | 'schedule'>,
): PublicationDispatchIssuePresentation | null {
  if (!hasPublicationScheduleError(publication)) return null;
  const reason = formatPublicationDeliveryError(publication.schedule?.lastError);
  return {
    canRecheck: false,
    description:
      reason && reason !== PUBLICATION_DELIVERY_ERROR_FALLBACK
        ? reason
        : 'Отправки по этому расписанию остановлены.',
    label: 'Ошибка расписания',
    title: 'Расписание остановлено',
  };
}

export function getPublicationDispatchIssuePresentation(
  issue: PublicationDispatchIssue | 'decision_required' | null,
  requiresScheduleDecision = false,
  hasFutureSends = false,
): PublicationDispatchIssuePresentation | null {
  if (issue === 'decision_required' || requiresScheduleDecision) {
    return {
      canRecheck: false,
      description: hasFutureSends
        ? 'Есть пропущенные запуски. В расписании остались другие отправки.'
        : 'Публикация не отправлена в назначенное время.',
      label: hasFutureSends ? 'Есть пропущенные отправки' : 'Пропущено время',
      title: hasFutureSends ? 'Есть пропущенные отправки' : 'Запуск пропущен',
    };
  }
  if (issue === 'actor_access_required') {
    return {
      canRecheck: true,
      description: 'Проверьте права администратора.',
      label: 'Ожидает доступа',
      title: 'Нужен доступ',
    };
  }
  if (issue === 'target_setup_required') {
    return {
      canRecheck: true,
      description: 'Проверьте подключение Публика.',
      label: 'Нужна настройка',
      title: 'Нужна настройка',
    };
  }
  if (issue === 'temporarily_unavailable') {
    return {
      canRecheck: false,
      description: 'Повторим автоматически.',
      label: 'Ожидает отправки',
      title: 'Отправка временно приостановлена',
    };
  }
  return null;
}

export function resolvePublicationDetailsDispatchIssue(
  details: Pick<PublicationDetails, 'dispatchIssue' | 'requiresScheduleDecision'> | undefined,
  summary: Pick<PublicationSummary, 'dispatchIssue' | 'requiresScheduleDecision'>,
): PublicationDispatchIssue | 'decision_required' | null {
  const source = details ?? summary;
  return source.requiresScheduleDecision ? 'decision_required' : source.dispatchIssue;
}

export function getPublicationFeedStatusLabel(publication: PublicationSummary): string {
  if (
    canReviewPublicationScheduleDecision(publication) &&
    getPublicationReviewCount(publication) === 0
  ) {
    return getPublicationDispatchIssuePresentation(
      publication.dispatchIssue,
      true,
      Boolean(publication.schedule?.nextOccurrenceAt),
    )!.label;
  }
  if (publication.lifecycle === 'ERROR') {
    return getPublicationLifecycleLabel(publication.lifecycle);
  }
  if (getPublicationReviewCount(publication) > 0) {
    return 'Нужно проверить';
  }
  if (publication.lifecycle !== 'ACTIVE') {
    return getPublicationLifecycleLabel(publication.lifecycle);
  }
  if (hasPublicationScheduleError(publication)) {
    return getPublicationScheduleErrorPresentation(publication)!.label;
  }
  return (
    getPublicationDispatchIssuePresentation(
      publication.dispatchIssue,
      publication.requiresScheduleDecision,
    )?.label ?? getPublicationLifecycleLabel(publication.lifecycle)
  );
}

export function canReviewPublicationScheduleDecision(
  publication: Pick<PublicationSummary, 'lifecycle' | 'requiresScheduleDecision'>,
): boolean {
  return (
    publication.requiresScheduleDecision === true &&
    (publication.lifecycle === 'ACTIVE' || publication.lifecycle === 'ERROR')
  );
}

export function getPublicationEditActionLabel(scope: PublicationEditScope | null): string {
  if (scope === 'future') {
    return 'Изменить будущие отправки';
  }
  if (scope === 'retry') {
    return 'Изменить версию для повтора';
  }
  return 'Изменить расписание';
}

export function getPublicationEditorTitle(
  scope: PublicationEditScope | null,
  importing: boolean,
): string {
  if (importing) return 'Черновик';
  if (scope === 'retry') return 'Версия для повтора';
  if (scope === 'future') return 'Будущие отправки';
  return scope === 'schedule' ? 'Расписание' : 'Новый пост';
}

export type PublicationTarget = {
  id: string;
  entityType: ManagedEntityType;
  title: string;
  avatarUrl: string | null;
  channelOverview: Pick<ChannelOverview, 'commentsEnabled' | 'postSuggestionsEnabled'> | null;
  publisherChatCommentsEnabled?: boolean;
  publisherChannelCommentsEnabled?: boolean;
  publisherChannelSuggestionsEnabled?: boolean;
  publisherChannelPostSignature?: ChannelPostSignatureSettings | null;
  readiness?: PublisherEntityReadiness | null;
};

export function getPublicationTargetTitle(
  target: Pick<PublicationTarget, 'entityType' | 'title'>,
): string {
  const title = target.title.trim();
  if (title) {
    return title;
  }
  return target.entityType === 'channel' ? 'Канал' : 'Чат';
}

export type PublicationDraft = {
  cloudDraft?: { id: string; revision: number };
  latePolicy?: PublicationLatePolicy;
  cloudRequestId?: string;
  postPublish: PublicationPostPublish;
  title: string;
  text: string;
  textFormat: BroadcastTextFormat;
  images: BroadcastImage[];
  buttons: BroadcastLinkButton[];
  buttonEnabled: boolean;
  targets: PublicationTarget[];
  timingMode: PublicationTimingMode;
  scheduleKind: PublicationScheduleKind;
  scheduledSlots: string[];
  onceDate: string;
  onceTime: string;
  scheduleTimezone: string;
  recurrence: PublicationRecurrenceDraft;
  mediaType: 'image' | 'video' | null;
  mediaPayload: Record<string, unknown> | null;
  mediaBase64: string;
  mediaMimeType: string;
  mediaFileName: string;
  retainedAssets: PublicationRetainedAsset[];
};

export type PublicationRecurrenceDraft = {
  frequency: PublicationRecurrenceFrequency;
  interval: number;
  weekdays: number[];
  times: string[];
  startsAt: string | null;
  endsAt: string | null;
  maxOccurrences: number | null;
};

export type PublicationRecurrenceIntervalNotice = {
  title: string;
  description: string;
};

export const PUBLICATION_TEXT_MAX_LENGTH = MAX_PUBLICATION_TEXT_LENGTH;
export const PUBLICATION_MIN_SCHEDULE_DELAY_MS = 2 * 60_000;
const PUBLICATION_SCHEDULE_CONFLICT_CODE = 'PUBLICATION_SCHEDULE_CONFLICT';
const PUBLICATION_REVISION_CONFLICT_CODE = 'PUBLICATION_REVISION_CONFLICT';

const PUBLICATION_STATUS_FILTERS_BY_VIEW: Record<
  PublicationView,
  readonly PublicationStatusFilter[]
> = {
  current: ['all', 'active', 'paused', 'failed'],
  schedules: ['all', 'active', 'paused', 'failed'],
  history: ['all', 'completed'],
};

const PUBLICATION_VIDEO_MIME_BY_EXTENSION: Record<string, string> = {
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  webm: 'video/webm',
};
const PUBLICATION_VIDEO_MIME_TYPES = new Set(Object.values(PUBLICATION_VIDEO_MIME_BY_EXTENSION));
const PUBLICATION_VIDEO_MIME_ALIASES: Record<string, string> = {
  'video/matroska': 'video/x-matroska',
};

export function isIsolatedPublicationEditor(kind: PublicationEditorKind | null): boolean {
  return kind === 'edit' || kind === 'duplicate' || kind === 'import' || kind === 'draft';
}

export function shouldPersistPublicationDraft(kind: PublicationEditorKind | null): boolean {
  return !isIsolatedPublicationEditor(kind);
}

export function canResumePublication(lifecycle: PublicationLifecycle): boolean {
  return lifecycle === 'PAUSED';
}

function getRussianCountUnit(count: number, one: string, few: string, many: string): string {
  const modulo100 = count % 100;
  if (modulo100 >= 11 && modulo100 <= 14) {
    return many;
  }
  const modulo10 = count % 10;
  if (modulo10 === 1) {
    return one;
  }
  if (modulo10 >= 2 && modulo10 <= 4) {
    return few;
  }
  return many;
}

export function getPublicationRecurrenceIntervalUnit(
  frequency: PublicationRecurrenceFrequency,
  interval: number,
): string {
  return frequency === 'daily'
    ? getRussianCountUnit(interval, 'день', 'дня', 'дней')
    : getRussianCountUnit(interval, 'неделю', 'недели', 'недель');
}

export function getPublicationRecurrenceIntervalNotice(
  frequency: PublicationRecurrenceFrequency,
  interval: number,
): PublicationRecurrenceIntervalNotice | null {
  if (!Number.isInteger(interval) || interval < 1) {
    return null;
  }

  if (frequency === 'daily') {
    if (interval === 31) {
      return {
        title: 'Каждые 31 день',
        description: 'Число месяца будет меняться.',
      };
    }
    if (interval >= 28) {
      return {
        title: `Каждые ${interval} ${getRussianCountUnit(interval, 'день', 'дня', 'дней')}`,
        description: 'Число месяца может меняться.',
      };
    }
    return null;
  }

  if (interval >= 4) {
    return {
      title: `${interval * 7} ${getRussianCountUnit(interval * 7, 'день', 'дня', 'дней')} между публикациями`,
      description: 'От даты начала расписания.',
    };
  }

  return null;
}

export function getPublicationActionCapabilities(
  publication: Pick<
    PublicationSummary,
    'access' | 'actionableDelivery' | 'delivery' | 'lifecycle' | 'schedule'
  >,
): PublicationActionCapabilities {
  const canManage = publication.access?.canManageAllTargets !== false;
  const terminal = publication.lifecycle === 'COMPLETED' || publication.lifecycle === 'CANCELED';
  const retryableLifecycle =
    publication.lifecycle === 'ACTIVE' || publication.lifecycle === 'ERROR';
  const actionableDelivery = getPublicationActionableDelivery(publication);
  const scheduleMode = publication.schedule?.mode;
  const hasFutureSends = Boolean(publication.schedule?.nextOccurrenceAt);
  const isMultiSendSchedule = scheduleMode === 'slots' || scheduleMode === 'recurrence';
  const scheduleError = hasPublicationScheduleError(publication);
  const hasUnresolvedDelivery = actionableDelivery.failed > 0 || actionableDelivery.ambiguous > 0;

  let editScope: PublicationEditScope | null = null;
  if (!terminal) {
    if (scheduleError && isMultiSendSchedule) {
      editScope = 'schedule';
    } else if (retryableLifecycle && !isMultiSendSchedule && hasUnresolvedDelivery) {
      editScope = 'retry';
    } else if (scheduleError) {
      editScope = 'schedule';
    } else if (hasFutureSends) {
      editScope = 'future';
    } else if (retryableLifecycle && actionableDelivery.failed > 0) {
      editScope = 'retry';
    } else if (scheduleMode && scheduleMode !== 'now') {
      editScope = 'schedule';
    }
  }

  return {
    canCancel: !terminal,
    canEdit: canManage && editScope !== null,
    canPause: canManage && retryableLifecycle && isMultiSendSchedule && !scheduleError,
    canResume: canManage && canResumePublication(publication.lifecycle),
    canRetry: canManage && retryableLifecycle && actionableDelivery.failed > 0,
    editScope: canManage ? editScope : null,
    hasFutureSends,
  };
}

export function getPublicationCancelActionLabel(
  publication: Parameters<typeof getPublicationActionCapabilities>[0],
): string {
  return publication.access?.canManageAllTargets === false
    ? 'Отменить отправки'
    : getPublicationActionCapabilities(publication).hasFutureSends
      ? 'Отменить будущие отправки'
      : 'Отменить публикацию';
}

export function normalizePublicationView(value: string | null): PublicationView {
  if (value === 'schedules' || value === 'history') {
    return value;
  }
  return 'current';
}

export function normalizePublicationQuery(value: string | null): string {
  return value?.slice(0, 120) ?? '';
}

export function normalizePublicationEntityFilter(value: string | null): PublicationEntityFilter {
  return value === 'chat' || value === 'channel' ? value : 'all';
}

export function normalizePublicationStatusFilter(
  value: string | null,
  view: PublicationView,
): PublicationStatusFilter {
  const candidate = value as PublicationStatusFilter | null;
  return candidate && PUBLICATION_STATUS_FILTERS_BY_VIEW[view].includes(candidate)
    ? candidate
    : 'all';
}

export function getPublicationActionableDelivery(
  publication: Pick<PublicationSummary, 'delivery' | 'actionableDelivery'>,
): PublicationDeliveryStats {
  return publication.actionableDelivery ?? publication.delivery;
}

export function getPublicationReviewCount(
  publication: Pick<PublicationSummary, 'delivery'>,
): number {
  // FLAG: Unknown effects remain reviewable across schedule revisions and authoritative stops.
  return publication.delivery.ambiguous;
}

export function getPublicationDispatchPendingCount(delivery: PublicationDeliveryStats): number {
  return delivery.dispatchPending ?? delivery.pending;
}

export function shouldPollPublicationDeliveries(
  publication: Pick<PublicationDetails, 'dispatchIssue' | 'lifecycle' | 'schedule'>,
  delivery: PublicationDeliveryStats,
): boolean {
  if (publication.lifecycle === 'COMPLETED' || publication.lifecycle === 'CANCELED') {
    return false;
  }
  return (
    getPublicationDispatchPendingCount(delivery) > 0 ||
    (publication.dispatchIssue === null &&
      publication.lifecycle === 'ACTIVE' &&
      publication.schedule?.mode === 'now' &&
      delivery.total === 0)
  );
}

export function getPublicationDetailsPollingInterval(
  publication: Pick<PublicationDetails, 'dispatchIssue' | 'lifecycle' | 'schedule'>,
  delivery: PublicationDeliveryStats,
  nowMs = Date.now(),
): number | false {
  if (publication.lifecycle === 'COMPLETED' || publication.lifecycle === 'CANCELED') {
    return false;
  }
  if (publication.dispatchIssue !== null) {
    return PUBLICATION_DISPATCH_ISSUE_POLL_INTERVAL_MS;
  }
  if (shouldPollPublicationDeliveries(publication, delivery)) return 5_000;
  if (
    publication.lifecycle !== 'ACTIVE' ||
    publication.schedule?.mode === 'now' ||
    publication.schedule?.status === 'ERROR'
  )
    return false;
  const nextAt = Date.parse(publication.schedule?.nextOccurrenceAt ?? '');
  if (!Number.isFinite(nextAt)) return 30_000;
  const untilNext = nextAt - nowMs;
  return untilNext <= 2 * 60_000
    ? 5_000
    : Math.min(15 * 60_000, Math.max(30_000, untilNext - 60_000));
}

export function getPublicationListPollingInterval(
  view: PublicationView,
  items: readonly PublicationPollingItem[],
  nowMs = Date.now(),
): number | false {
  if (view === 'history') {
    return false;
  }
  if (
    items.some(
      (item) =>
        item.lifecycle !== 'COMPLETED' &&
        item.lifecycle !== 'CANCELED' &&
        !item.dispatchIssue &&
        getPublicationDispatchPendingCount(getPublicationActionableDelivery(item)) > 0,
    )
  ) {
    return 5_000;
  }
  if (
    items.some(
      (item) => item.dispatchIssue && (item.lifecycle === 'ACTIVE' || item.lifecycle === 'ERROR'),
    )
  ) {
    return PUBLICATION_DISPATCH_ISSUE_POLL_INTERVAL_MS;
  }
  if (view === 'current') {
    return items.some((item) => {
      const delivery = getPublicationActionableDelivery(item);
      return item.lifecycle === 'ACTIVE' && item.schedule?.mode === 'now' && delivery.total === 0;
    })
      ? 5_000
      : false;
  }

  const nextActiveOccurrenceMs = items.reduce<number | null>((nearest, item) => {
    if (
      item.lifecycle !== 'ACTIVE' ||
      item.schedule?.status === 'ERROR' ||
      !item.schedule?.nextOccurrenceAt
    ) {
      return nearest;
    }
    const candidate = Date.parse(item.schedule.nextOccurrenceAt);
    if (!Number.isFinite(candidate)) {
      return nearest;
    }
    return nearest === null || candidate < nearest ? candidate : nearest;
  }, null);
  if (nextActiveOccurrenceMs === null) {
    return false;
  }

  const untilNextOccurrence = nextActiveOccurrenceMs - nowMs;
  if (untilNextOccurrence <= 2 * 60_000) {
    return 10_000;
  }
  return Math.min(15 * 60_000, Math.max(60_000, untilNextOccurrence - 60_000));
}

export function isPublicationOccurrenceContentStale(
  occurrence: Pick<PublicationOccurrenceSummary, 'contentRevision' | 'usesLatestContent'>,
  latestContentRevision: number,
): boolean {
  if (occurrence.usesLatestContent !== undefined) {
    return !occurrence.usesLatestContent;
  }
  return (
    occurrence.contentRevision !== undefined && occurrence.contentRevision !== latestContentRevision
  );
}

export function buildPublicationSaveFeedback(
  publication: Pick<PublicationDetails, 'delivery'>,
  options: {
    editScope?: PublicationEditScope | null;
    editorKind: PublicationEditorKind | null;
    timingMode: PublicationTimingMode;
  },
): PublicationSaveFeedback {
  if (options.editorKind === 'edit') {
    return {
      tone: 'success',
      title:
        options.editScope === 'retry'
          ? 'Версия для повтора сохранена'
          : options.editScope === 'schedule'
            ? 'Расписание обновлено'
            : 'Будущие отправки обновлены',
      notification: 'success',
    };
  }
  if (options.timingMode === 'once') {
    return {
      tone: 'success',
      title: 'Публикация запланирована',
      notification: 'success',
    };
  }
  if (options.timingMode === 'schedule') {
    return {
      tone: 'success',
      title: 'Расписание сохранено',
      notification: 'success',
    };
  }

  const delivery = publication.delivery;
  if (delivery.ambiguous > 0) {
    return {
      tone: 'info',
      title: 'Отправка требует проверки',
      description: 'MAX мог принять сообщение без подтверждения. Проверьте детали публикации.',
      notification: 'warning',
    };
  }
  const undelivered = delivery.failed + delivery.canceled;
  if (undelivered > 0 && delivery.pending === 0) {
    return {
      tone: 'danger',
      title: 'Не все сообщения отправлены',
      description: `Доставлено: ${delivery.sent}/${delivery.total}, не доставлено: ${undelivered}.`,
      notification: 'error',
    };
  }
  if (delivery.total > 0 && delivery.sent === delivery.total) {
    return {
      tone: 'success',
      title: 'Публикация отправлена',
      description: `Доставлено: ${delivery.sent}/${delivery.total}.`,
      notification: 'success',
    };
  }
  if (undelivered > 0) {
    return {
      tone: 'info',
      title: 'Отправка продолжается',
      description: `Доставлено: ${delivery.sent}/${delivery.total}, не доставлено: ${undelivered}.`,
      notification: 'warning',
    };
  }
  return {
    tone: 'info',
    title: 'Начинаем отправку',
    description: 'Результат появится в списке постов после ответа MAX.',
    notification: 'success',
  };
}

export function isPublicationScheduleConflictMessage(message: string): boolean {
  const normalized = message.trim().toLocaleLowerCase('ru-RU');
  return (
    (normalized.includes('врем') &&
      (normalized.includes('занят') || normalized.includes('уже заплан'))) ||
    (normalized.includes('расписан') && normalized.includes('пересеч'))
  );
}

export function isPublicationScheduleConflictError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code === PUBLICATION_SCHEDULE_CONFLICT_CODE;
    }
  }

  return error instanceof Error && isPublicationScheduleConflictMessage(error.message);
}

export function isPublicationRevisionConflictError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === PUBLICATION_REVISION_CONFLICT_CODE,
  );
}

export function shouldReviewPublicationScheduleConflict(
  error: unknown,
  draft: Pick<PublicationDraft, 'timingMode' | 'scheduleKind'>,
  replaceConflicts: boolean,
): boolean {
  return (
    !replaceConflicts && draft.timingMode !== 'now' && isPublicationScheduleConflictError(error)
  );
}

export function inferPublicationVideoMimeType(fileName: string, mimeType: string): string | null {
  const normalizedMimeType = mimeType.trim().toLowerCase();
  const extension =
    fileName
      .trim()
      .toLowerCase()
      .match(/\.([a-z0-9]+)$/u)?.[1] ?? '';
  const extensionMimeType = Object.hasOwn(PUBLICATION_VIDEO_MIME_BY_EXTENSION, extension)
    ? (PUBLICATION_VIDEO_MIME_BY_EXTENSION[extension] ?? null)
    : null;
  if (normalizedMimeType) {
    const canonicalMimeType =
      PUBLICATION_VIDEO_MIME_ALIASES[normalizedMimeType] ?? normalizedMimeType;
    if (PUBLICATION_VIDEO_MIME_TYPES.has(canonicalMimeType)) {
      return canonicalMimeType;
    }
    if (normalizedMimeType === 'application/octet-stream') {
      return extensionMimeType;
    }
    return null;
  }

  return extensionMimeType;
}

export function publicationDraftNeedsVideoReselection(
  draft: Pick<PublicationDraft, 'mediaBase64' | 'mediaPayload' | 'mediaType' | 'retainedAssets'>,
): boolean {
  return (
    draft.mediaType === 'video' &&
    !draft.mediaBase64 &&
    !draft.mediaPayload &&
    !draft.retainedAssets.some((asset) => asset.type === 'video')
  );
}

export function toPublicationTarget(source: ChatSummary): PublicationTarget {
  const channelOverview = source.entityType === 'channel' ? source.channelOverview : null;
  return {
    id: source.id,
    entityType: source.entityType,
    title: getPublicationTargetTitle(source),
    avatarUrl: source.avatarUrl ?? null,
    channelOverview: channelOverview
      ? {
          commentsEnabled: channelOverview.commentsEnabled,
          postSuggestionsEnabled: channelOverview.postSuggestionsEnabled,
        }
      : null,
    readiness: null,
  };
}

export function buildPublicationSystemButtons(
  targets: readonly Pick<
    PublicationTarget,
    | 'channelOverview'
    | 'entityType'
    | 'publisherChannelCommentsEnabled'
    | 'publisherChannelPostSignature'
    | 'publisherChannelSuggestionsEnabled'
    | 'publisherChatCommentsEnabled'
  >[],
): BroadcastSystemButtonPreview[] {
  const previews = targets.map((target) =>
    buildChannelBroadcastSystemButtons({
      commentsEnabled:
        (target.entityType === 'chat' && target.publisherChatCommentsEnabled === true) ||
        (target.entityType === 'channel' &&
          (target.publisherChannelCommentsEnabled === true ||
            target.channelOverview?.commentsEnabled === true)),
      postSuggestionsEnabled:
        target.entityType === 'channel' &&
        (target.publisherChannelSuggestionsEnabled === true ||
          target.channelOverview?.postSuggestionsEnabled === true),
      postSuggestionsButtonText:
        target.entityType === 'channel' && target.publisherChannelSuggestionsEnabled === true
          ? '✍️ Предложить объявление'
          : null,
      ctaButtonEnabled:
        target.entityType === 'channel' &&
        target.publisherChannelPostSignature?.enabled === true &&
        target.publisherChannelPostSignature.presentation === 'button',
      ctaButtonText:
        target.entityType === 'channel' ? target.publisherChannelPostSignature?.text : null,
    }),
  );
  const firstPreview = previews[0] ?? [];
  const allMatch = previews.every(
    (preview) =>
      preview.length === firstPreview.length &&
      preview.every(
        (button, index) =>
          button.kind === firstPreview[index]?.kind && button.text === firstPreview[index]?.text,
      ),
  );

  return allMatch ? firstPreview : [];
}

export function getPublicationTargetKey(
  target: Pick<PublicationTarget, 'id' | 'entityType'>,
): string {
  return `${target.entityType}:${target.id}`;
}

export function hasSamePublicationTargetMetadata(
  left: PublicationTarget,
  right: PublicationTarget,
): boolean {
  const leftReadiness = left.readiness ?? null;
  const rightReadiness = right.readiness ?? null;
  return (
    left.title === right.title &&
    left.avatarUrl === right.avatarUrl &&
    left.channelOverview?.commentsEnabled === right.channelOverview?.commentsEnabled &&
    left.channelOverview?.postSuggestionsEnabled ===
      right.channelOverview?.postSuggestionsEnabled &&
    Boolean(left.publisherChatCommentsEnabled) === Boolean(right.publisherChatCommentsEnabled) &&
    Boolean(left.publisherChannelCommentsEnabled) ===
      Boolean(right.publisherChannelCommentsEnabled) &&
    Boolean(left.publisherChannelSuggestionsEnabled) ===
      Boolean(right.publisherChannelSuggestionsEnabled) &&
    left.publisherChannelPostSignature?.enabled === right.publisherChannelPostSignature?.enabled &&
    left.publisherChannelPostSignature?.presentation ===
      right.publisherChannelPostSignature?.presentation &&
    left.publisherChannelPostSignature?.text === right.publisherChannelPostSignature?.text &&
    left.publisherChannelPostSignature?.url === right.publisherChannelPostSignature?.url &&
    leftReadiness?.state === rightReadiness?.state &&
    leftReadiness?.canPublish === rightReadiness?.canPublish &&
    leftReadiness?.canUseChatComments === rightReadiness?.canUseChatComments &&
    leftReadiness?.canUseChannelComments === rightReadiness?.canUseChannelComments &&
    leftReadiness?.canPublishSuggestions === rightReadiness?.canPublishSuggestions &&
    leftReadiness?.blockerCode === rightReadiness?.blockerCode &&
    leftReadiness?.checkedAt === rightReadiness?.checkedAt &&
    leftReadiness?.retryAt === rightReadiness?.retryAt
  );
}

export function createEmptyPublicationDraft(targets: PublicationTarget[] = []): PublicationDraft {
  return {
    postPublish: { pin: 'none', deleteAfterMinutes: null },
    latePolicy: { ...DEFAULT_PUBLICATION_LATE_POLICY },
    title: '',
    text: '',
    textFormat: 'markdown',
    images: [],
    buttons: [],
    buttonEnabled: false,
    targets,
    timingMode: 'now',
    scheduleKind: 'slots',
    scheduledSlots: [],
    onceDate: '',
    onceTime: '',
    scheduleTimezone: resolveBroadcastScheduleTimezone(),
    recurrence: {
      frequency: 'weekly',
      interval: 1,
      weekdays: [],
      times: [],
      startsAt: null,
      endsAt: null,
      maxOccurrences: null,
    },
    mediaType: null,
    mediaPayload: null,
    mediaBase64: '',
    mediaMimeType: '',
    mediaFileName: '',
    retainedAssets: [],
  };
}

export function createPublicationDuplicateDraft(draft: PublicationDraft): PublicationDraft {
  const empty = createEmptyPublicationDraft();
  return {
    ...draft,
    timingMode: 'schedule',
    scheduleKind: 'slots',
    scheduledSlots: [],
    onceDate: '',
    onceTime: '',
    recurrence: empty.recurrence,
  };
}

export function isPublicationDraftEmpty(draft: PublicationDraft): boolean {
  return !(
    draft.postPublish.pin !== 'none' ||
    draft.postPublish.deleteAfterMinutes !== null ||
    draft.title.trim() ||
    draft.text.trim() ||
    draft.images.length > 0 ||
    draft.retainedAssets.length > 0 ||
    draft.buttons.some((button) => button.text.trim() || button.url.trim()) ||
    draft.mediaType === 'video'
  );
}

function arraysEqual<T>(
  left: readonly T[],
  right: readonly T[],
  equals: (leftItem: T, rightItem: T) => boolean,
): boolean {
  return (
    left.length === right.length && left.every((item, index) => equals(item, right[index] as T))
  );
}

export function hasPublicationDraftChanges(
  initialDraft: PublicationDraft,
  currentDraft: PublicationDraft,
): boolean {
  const initialRecurrence = initialDraft.recurrence;
  const currentRecurrence = currentDraft.recurrence;

  return !(
    initialDraft.title === currentDraft.title &&
    initialDraft.text === currentDraft.text &&
    initialDraft.textFormat === currentDraft.textFormat &&
    initialDraft.postPublish.pin === currentDraft.postPublish.pin &&
    initialDraft.postPublish.deleteAfterMinutes === currentDraft.postPublish.deleteAfterMinutes &&
    initialDraft.buttonEnabled === currentDraft.buttonEnabled &&
    JSON.stringify(initialDraft.latePolicy) === JSON.stringify(currentDraft.latePolicy) &&
    initialDraft.timingMode === currentDraft.timingMode &&
    initialDraft.scheduleKind === currentDraft.scheduleKind &&
    initialDraft.onceDate === currentDraft.onceDate &&
    initialDraft.onceTime === currentDraft.onceTime &&
    initialDraft.scheduleTimezone === currentDraft.scheduleTimezone &&
    initialDraft.mediaType === currentDraft.mediaType &&
    initialDraft.mediaBase64 === currentDraft.mediaBase64 &&
    initialDraft.mediaMimeType === currentDraft.mediaMimeType &&
    initialDraft.mediaFileName === currentDraft.mediaFileName &&
    JSON.stringify(initialDraft.mediaPayload) === JSON.stringify(currentDraft.mediaPayload) &&
    arraysEqual(
      initialDraft.images,
      currentDraft.images,
      (left, right) =>
        left.base64 === right.base64 &&
        left.mimeType === right.mimeType &&
        left.fileName === right.fileName,
    ) &&
    arraysEqual(
      initialDraft.buttons,
      currentDraft.buttons,
      (left, right) => left.text === right.text && left.url === right.url,
    ) &&
    arraysEqual(
      initialDraft.targets,
      currentDraft.targets,
      (left, right) => getPublicationTargetKey(left) === getPublicationTargetKey(right),
    ) &&
    arraysEqual(
      initialDraft.scheduledSlots,
      currentDraft.scheduledSlots,
      (left, right) => left === right,
    ) &&
    initialRecurrence.frequency === currentRecurrence.frequency &&
    initialRecurrence.interval === currentRecurrence.interval &&
    initialRecurrence.startsAt === currentRecurrence.startsAt &&
    initialRecurrence.endsAt === currentRecurrence.endsAt &&
    initialRecurrence.maxOccurrences === currentRecurrence.maxOccurrences &&
    arraysEqual(
      initialRecurrence.weekdays,
      currentRecurrence.weekdays,
      (left, right) => left === right,
    ) &&
    arraysEqual(
      initialRecurrence.times,
      currentRecurrence.times,
      (left, right) => left === right,
    ) &&
    arraysEqual(
      initialDraft.retainedAssets,
      currentDraft.retainedAssets,
      (left, right) =>
        left.id === right.id &&
        left.type === right.type &&
        left.mimeType === right.mimeType &&
        left.fileName === right.fileName &&
        left.sizeBytes === right.sizeBytes &&
        left.sourcePublicationId === right.sourcePublicationId,
    )
  );
}

export function rebasePublicationDraft(
  baseline: PublicationDraft,
  local: PublicationDraft,
  latest: PublicationDraft,
): PublicationDraft {
  const changed = (keys: readonly (keyof PublicationDraft)[]) =>
    keys.some((key) => {
      const baselineValue = baseline[key];
      const localValue = local[key];
      if (baselineValue === localValue) {
        return false;
      }
      if (
        baselineValue &&
        localValue &&
        typeof baselineValue === 'object' &&
        typeof localValue === 'object'
      ) {
        return JSON.stringify(baselineValue) !== JSON.stringify(localValue);
      }
      return true;
    });
  const buttonsChanged = changed(['buttonEnabled', 'buttons']);
  const textChanged = changed(['text', 'textFormat']);
  const targetsChanged = changed(['targets']);
  const scheduleChanged = changed([
    'latePolicy',
    'timingMode',
    'scheduleKind',
    'scheduledSlots',
    'onceDate',
    'onceTime',
    'scheduleTimezone',
    'recurrence',
  ]);
  const mediaChanged = changed([
    'images',
    'mediaType',
    'mediaPayload',
    'mediaBase64',
    'mediaMimeType',
    'mediaFileName',
    'retainedAssets',
  ]);

  return {
    ...latest,
    postPublish: changed(['postPublish']) ? local.postPublish : latest.postPublish,
    title: baseline.title !== local.title ? local.title : latest.title,
    text: textChanged ? local.text : latest.text,
    textFormat: textChanged ? local.textFormat : latest.textFormat,
    ...(buttonsChanged
      ? { buttonEnabled: local.buttonEnabled, buttons: local.buttons }
      : { buttonEnabled: latest.buttonEnabled, buttons: latest.buttons }),
    targets: targetsChanged ? local.targets : latest.targets,
    ...(scheduleChanged
      ? {
          latePolicy: local.latePolicy,
          timingMode: local.timingMode,
          scheduleKind: local.scheduleKind,
          scheduledSlots: local.scheduledSlots,
          onceDate: local.onceDate,
          onceTime: local.onceTime,
          scheduleTimezone: local.scheduleTimezone,
          recurrence: local.recurrence,
        }
      : {
          latePolicy: latest.latePolicy,
          timingMode: latest.timingMode,
          scheduleKind: latest.scheduleKind,
          scheduledSlots: latest.scheduledSlots,
          onceDate: latest.onceDate,
          onceTime: latest.onceTime,
          scheduleTimezone: latest.scheduleTimezone,
          recurrence: latest.recurrence,
        }),
    ...(mediaChanged
      ? {
          images: local.images,
          mediaType: local.mediaType,
          mediaPayload: local.mediaPayload,
          mediaBase64: local.mediaBase64,
          mediaMimeType: local.mediaMimeType,
          mediaFileName: local.mediaFileName,
          retainedAssets: local.retainedAssets,
        }
      : {
          images: latest.images,
          mediaType: latest.mediaType,
          mediaPayload: latest.mediaPayload,
          mediaBase64: latest.mediaBase64,
          mediaMimeType: latest.mediaMimeType,
          mediaFileName: latest.mediaFileName,
          retainedAssets: latest.retainedAssets,
        }),
  };
}

export function buildPublicationContent(draft: PublicationDraft): PublicationContentInput {
  const buttons = (draft.buttonEnabled ? trimBroadcastLinkButtons(draft.buttons) : []).map(
    (button, index) => ({ ...button, row: index }),
  );
  const selectedVideo =
    draft.mediaType === 'video' && (draft.mediaBase64 || draft.mediaPayload)
      ? {
          type: 'video' as const,
          payload: draft.mediaPayload,
          base64: draft.mediaBase64,
          mimeType: draft.mediaMimeType,
          fileName: draft.mediaFileName,
        }
      : null;
  const retainedVideo = draft.retainedAssets.find((asset) => asset.type === 'video');
  const retainedImages = draft.retainedAssets
    .filter((asset) => asset.type === 'image')
    .map((asset) => ({
      type: 'image-ref' as const,
      assetId: asset.id,
      ...(asset.sourcePublicationId || draft.cloudDraft?.id
        ? { sourcePublicationId: asset.sourcePublicationId ?? draft.cloudDraft?.id }
        : {}),
    }));
  const newImages = draft.images.map((image) => ({
    type: 'image' as const,
    base64: image.base64,
    mimeType: image.mimeType,
    fileName: image.fileName,
  }));
  const media = selectedVideo
    ? [selectedVideo]
    : retainedVideo
      ? [
          {
            type: 'video-ref' as const,
            assetId: retainedVideo.id,
            ...(retainedVideo.sourcePublicationId || draft.cloudDraft?.id
              ? { sourcePublicationId: retainedVideo.sourcePublicationId ?? draft.cloudDraft?.id }
              : {}),
          },
        ]
      : [...retainedImages, ...newImages];

  return {
    text: draft.text.trim(),
    postPublish: draft.postPublish,
    textFormat: draft.textFormat,
    buttons,
    media,
  };
}

export function buildPublicationSchedule(
  draft: PublicationDraft,
  replaceConflicts = false,
): PublicationScheduleInput {
  if (draft.timingMode === 'now') {
    return { mode: 'now', timezone: draft.scheduleTimezone };
  }
  if (draft.timingMode === 'once') {
    return {
      mode: 'once',
      timezone: draft.scheduleTimezone,
      at: getPublicationOnceSlot(draft) ?? '',
      replaceConflicts,
      latePolicy: draft.latePolicy,
    };
  }
  if (draft.scheduleKind === 'recurrence') {
    return {
      mode: 'recurrence',
      timezone: draft.scheduleTimezone,
      frequency: draft.recurrence.frequency,
      interval: draft.recurrence.interval,
      weekdays: draft.recurrence.frequency === 'weekly' ? draft.recurrence.weekdays : [],
      times: draft.recurrence.times,
      startsAt: draft.recurrence.startsAt,
      endsAt: draft.recurrence.endsAt,
      maxOccurrences: draft.recurrence.maxOccurrences,
      replaceConflicts,
      latePolicy: draft.latePolicy,
    };
  }
  return {
    mode: 'slots',
    timezone: draft.scheduleTimezone,
    slots: sortAndUniqueBroadcastSlots(draft.scheduledSlots),
    replaceConflicts,
    latePolicy: draft.latePolicy,
  };
}

export function canPreservePublicationSchedule(
  context: PublicationEditorContext | null,
  baseline: PublicationDraft | null,
  draft: PublicationDraft,
): boolean {
  if (context?.kind !== 'edit' || context.editScope !== 'future' || !baseline) return false;
  // FLAG: Content-only edits must preserve saved slots/deadlines, including dates hidden by the editor.
  // Changing recipients requires schedule validation because the server rebuilds their deliveries.
  const targetKeys = (value: PublicationDraft) => value.targets.map(getPublicationTargetKey).sort();
  return (
    JSON.stringify(targetKeys(baseline)) === JSON.stringify(targetKeys(draft)) &&
    JSON.stringify(buildPublicationSchedule(baseline)) ===
      JSON.stringify(buildPublicationSchedule(draft))
  );
}

export function getPublicationExplicitSlotsLimitFeedback(
  draft: Pick<PublicationDraft, 'timingMode' | 'scheduleKind' | 'scheduledSlots'>,
): PublicationSaveFeedback | null {
  if (draft.timingMode !== 'schedule' || draft.scheduleKind !== 'slots') {
    return null;
  }

  const slotCount = sortAndUniqueBroadcastSlots(draft.scheduledSlots).length;
  if (slotCount <= MAX_PUBLICATION_EXPLICIT_SLOTS) {
    return null;
  }

  return {
    tone: 'danger',
    title: `Можно запланировать не более ${MAX_PUBLICATION_EXPLICIT_SLOTS} отправок.`,
    notification: 'error',
  };
}

export function buildCreatePublicationRequest(
  draft: PublicationDraft,
  requestId: string,
  options: { intent?: 'draft' | 'publish'; replaceConflicts?: boolean } = {},
): CreatePublicationRequest {
  return {
    requestId,
    title: draft.title.trim(),
    content: buildPublicationContent(draft),
    audience: {
      selection: 'SELECTED',
      mode: 'SNAPSHOT',
      targets: draft.targets.map((target) => ({
        chatId: target.id,
        entityType: target.entityType,
      })),
    },
    schedule:
      options.intent === 'draft'
        ? null
        : buildPublicationSchedule(draft, options.replaceConflicts ?? false),
    intent: options.intent ?? 'publish',
  };
}

export function buildUpdatePublicationRequest(
  draft: PublicationDraft,
  expectedRevision: number,
  requestId: string,
  replaceConflicts = false,
  contentOnly = false,
): UpdatePublicationRequest {
  const contentRequest = {
    expectedRevision,
    requestId,
    title: draft.title.trim(),
    content: buildPublicationContent(draft),
  };
  if (contentOnly) return contentRequest;

  return {
    ...contentRequest,
    audience: {
      selection: 'SELECTED',
      mode: 'SNAPSHOT',
      targets: draft.targets.map((target) => ({
        chatId: target.id,
        entityType: target.entityType,
      })),
    },
    schedule: buildPublicationSchedule(draft, replaceConflicts),
    intent: 'publish',
  };
}

export function buildTestPublicationRequest(
  draft: PublicationDraft,
  requestId: string,
): TestPublicationRequest {
  const sourceTarget = draft.targets[0];
  return {
    requestId,
    content: {
      ...buildPublicationContent(draft),
      postPublish: { pin: 'none', deleteAfterMinutes: null },
    },
    sourceTarget: {
      chatId: sourceTarget?.id ?? '',
      entityType: sourceTarget?.entityType ?? 'chat',
    },
  };
}

export function createPublicationDraftFromDetails(
  details: PublicationDetails,
  nowMs = Date.now(),
): PublicationDraft {
  const fallback = createEmptyPublicationDraft();
  const schedule = details.schedule;
  const timingMode: PublicationTimingMode =
    !schedule || schedule.mode === 'now' ? 'now' : schedule.mode === 'once' ? 'once' : 'schedule';
  const scheduledSlots =
    schedule?.mode === 'once'
      ? [schedule.at]
      : schedule?.mode === 'slots'
        ? filterFuturePublicationSlots(schedule.slots, nowMs, 0)
        : fallback.scheduledSlots;
  const recurrence =
    schedule?.mode === 'recurrence'
      ? {
          frequency: schedule.frequency,
          interval: schedule.interval,
          weekdays: schedule.weekdays,
          times: schedule.times,
          startsAt: schedule.startsAt,
          endsAt: schedule.endsAt,
          maxOccurrences: schedule.maxOccurrences,
        }
      : fallback.recurrence;
  const onceValue =
    schedule?.mode === 'once' ? formatPublicationScheduleField(schedule.at, schedule.timezone) : '';
  const [onceDate = '', onceTime = ''] = onceValue.split('T');

  return {
    ...fallback,
    title: details.title,
    postPublish: publicationPostPublishSchema.parse(details.content.postPublish ?? {}),
    text: details.content.text,
    textFormat: details.content.textFormat,
    buttons: details.content.buttons.map(({ text, url }) => ({ text, url })),
    buttonEnabled: details.content.buttons.length > 0,
    targets: details.targets.map((target) => ({
      id: target.chatId,
      entityType: target.entityType,
      title: getPublicationTargetTitle(target),
      avatarUrl: target.avatarUrl,
      channelOverview: null,
    })),
    timingMode,
    scheduleKind: schedule?.mode === 'recurrence' ? 'recurrence' : 'slots',
    scheduledSlots: scheduledSlots.length > 0 ? scheduledSlots : fallback.scheduledSlots,
    onceDate,
    onceTime,
    scheduleTimezone: schedule?.timezone ?? fallback.scheduleTimezone,
    latePolicy: schedule && 'latePolicy' in schedule ? schedule.latePolicy : undefined,
    recurrence,
    mediaType: null,
    mediaPayload: null,
    mediaBase64: '',
    mediaMimeType: '',
    mediaFileName: '',
    retainedAssets: details.content.media.map((asset) => ({
      ...asset,
      sourcePublicationId: details.id,
    })),
  };
}

export function filterFuturePublicationSlots(
  slots: readonly string[],
  nowMs = Date.now(),
  minDelayMs = PUBLICATION_MIN_SCHEDULE_DELAY_MS,
): string[] {
  const minTime = nowMs + minDelayMs;
  return sortAndUniqueBroadcastSlots([...slots]).filter((slot) => {
    const parsed = Date.parse(slot);
    return Number.isFinite(parsed) && parsed >= minTime;
  });
}

export function hasFuturePublicationSlot(slots: readonly string[], nowMs = Date.now()): boolean {
  const minTime = nowMs + PUBLICATION_MIN_SCHEDULE_DELAY_MS;
  return slots.some((slot) => {
    const parsed = new Date(slot).getTime();
    return Number.isFinite(parsed) && parsed >= minTime;
  });
}

export function getPublicationOnceSlot(
  draft: Pick<PublicationDraft, 'onceDate' | 'onceTime' | 'scheduleTimezone' | 'scheduledSlots'>,
): string | null {
  const at = draft.scheduledSlots[0];
  if (!at || !draft.onceDate || !draft.onceTime) return null;
  // FLAG: Never submit a cached calendar slot that disagrees with the visible one-time fields.
  return formatPublicationScheduleField(at, draft.scheduleTimezone) ===
    `${draft.onceDate}T${draft.onceTime}`
    ? at
    : null;
}

export function getPublicationTimingIssue(
  draft: PublicationDraft,
  nowMs = Date.now(),
): { field: 'date' | 'time' | 'schedule'; label: string; message: string } | null {
  if (draft.timingMode === 'once') {
    if (!draft.onceDate)
      return { field: 'date', label: 'Дата', message: 'Выберите дату публикации.' };
    if (!draft.onceTime)
      return { field: 'time', label: 'Время', message: 'Выберите время публикации.' };
    const at = getPublicationOnceSlot(draft);
    if (!at)
      return {
        field: 'time',
        label: 'Время',
        message:
          'Заново выберите дату и время публикации: они не соответствуют выбранному часовому поясу.',
      };
    if (hasFuturePublicationSlot([at], nowMs)) return null;
    return {
      field: 'time',
      label: 'Время',
      message: 'Выберите время минимум на 2 минуты позже текущего.',
    };
  }
  if (
    draft.timingMode === 'schedule' &&
    draft.scheduleKind === 'slots' &&
    !hasFuturePublicationSlot(draft.scheduledSlots, nowMs)
  )
    return {
      field: 'schedule',
      label: 'Время',
      message: 'Добавьте дату и время минимум на 2 минуты позже текущего.',
    };
  return null;
}

export function matchesPublicationSearch(
  values: readonly (string | null | undefined)[],
  query: string,
): boolean {
  const normalized = query.trim().toLocaleLowerCase('ru-RU');
  if (!normalized) {
    return true;
  }

  return values.some((value) => value?.toLocaleLowerCase('ru-RU').includes(normalized));
}
