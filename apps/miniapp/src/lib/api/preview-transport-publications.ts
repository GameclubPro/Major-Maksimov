import { type ManagedBroadcastDetails, type ManagedEntityType } from '@maxim/contracts';
import {
  createPublicationRequestSchema,
  decodeLegacyPublicationListCursor,
  decodePublicationListCursor,
  encodeLegacyPublicationListCursor,
  encodePublicationListCursor,
  listLegacyPublicationsQuerySchema,
  listLegacyPublicationsResponseSchema,
  listPublicationDeliveriesQuerySchema,
  listPublicationDeliveriesResponseSchema,
  listPublicationsQuerySchema,
  listPublicationsResponseSchema,
  publicationActionRequestSchema,
  publicationCalendarAvailabilityRequestSchema,
  publicationCalendarAvailabilityResponseSchema,
  publicationDetailsSchema,
  publicationOccurrenceRescheduleRequestSchema,
  type PublicationPostActions,
  publicationTargetsRefreshResponseSchema,
  resolvePublicationAmbiguousDeliveryRequestSchema,
  retryPublicationOccurrenceRequestSchema,
  testPublicationRequestSchema,
  updatePublicationRequestSchema,
  type CreatePublicationRequest,
  type LegacyPublicationSummary,
  type PublicationAsset,
  type PublicationContentInput,
  type PublicationDelivery,
  type PublicationDeliveryStats,
  type PublicationDetails,
  type PublicationScheduleInput,
  type PublicationTarget,
} from '@maxim/contracts/publication';
import { publicationPostActionRequestSchema } from '@maxim/contracts/publication-post-action-request';
import { confirmPreviewCalendarReplacement } from './preview-publication-conflict';
import { reschedulePreviewPublication } from './preview-publication-reschedule';
import {
  PREVIEW_CHANNEL_ID,
  PREVIEW_CHANNEL_TITLE,
  PREVIEW_CHAT_ID,
  PREVIEW_CHAT_TITLE,
} from '../design-preview';
import type { PreviewState } from './preview-transport-state';
import { recordPreviewPublisherRefresh } from './preview-transport-publisher';
import {
  PREVIEW_NOT_HANDLED,
  readPreviewClock,
  type PreviewRequestHandler,
} from './preview-transport-runtime';
import { addDays, addHours, cloneJson, parseJsonBody } from './preview-transport-shared';
import { stripSupportedMarkdownToPlainText } from '../max-markdown';

const previewPostActionRequests = new WeakMap<PreviewState, Map<string, string>>();
import { normalizeLegacyMultilineMarkdown } from '../max-markdown-multiline';
import {
  getPreviewUploadedVideos,
  handlePublicationVideoPreviewRequest,
} from './preview-transport-publication-video';

function resolvePublicationContentPreview(content: PublicationContentInput): string {
  const source = content.text.trim();
  return (
    content.textFormat === 'markdown'
      ? stripSupportedMarkdownToPlainText(normalizeLegacyMultilineMarkdown(source))
      : source
  ).slice(0, 160);
}

function resolvePreviewSource(
  state: PreviewState,
  entityType: ManagedEntityType,
  sourceChatId: string,
) {
  const sources = entityType === 'channel' ? state.channels : state.chats;
  return sources.find((item) => item.id === sourceChatId) ?? null;
}

export function createEmptyPublicationDeliveryStats(): PublicationDeliveryStats {
  return {
    total: 0,
    pending: 0,
    sent: 0,
    failed: 0,
    ambiguous: 0,
    canceled: 0,
  };
}

export function buildPreviewPublicationDeliveryStats(
  deliveries: readonly PublicationDelivery[],
): PublicationDeliveryStats {
  return deliveries.reduce<PublicationDeliveryStats>((stats, delivery) => {
    stats.total += 1;
    if (delivery.status === 'PENDING' || delivery.status === 'SENDING') {
      stats.pending += 1;
    } else if (delivery.status === 'SENT') {
      stats.sent += 1;
    } else if (delivery.status === 'FAILED') {
      stats.failed += 1;
    } else if (delivery.status === 'AMBIGUOUS') {
      stats.ambiguous += 1;
    } else if (delivery.status === 'CANCELED') {
      stats.canceled += 1;
    }
    return stats;
  }, createEmptyPublicationDeliveryStats());
}

export function resolvePreviewPublicationTarget(
  state: PreviewState,
  target: { chatId: string; entityType: 'chat' | 'channel' },
): PublicationTarget {
  const source =
    target.entityType === 'channel'
      ? state.channels.find((item) => item.id === target.chatId)
      : state.chats.find((item) => item.id === target.chatId);
  return {
    chatId: target.chatId,
    entityType: target.entityType,
    title:
      source?.title ??
      (target.entityType === 'channel' ? PREVIEW_CHANNEL_TITLE : PREVIEW_CHAT_TITLE),
    avatarUrl: source?.avatarUrl ?? null,
    link: source?.link ?? null,
  };
}

export function buildPreviewPublicationAssets(
  publicationId: string,
  content: PublicationContentInput,
  retainedAssets: readonly PublicationAsset[] = [],
): PublicationAsset[] {
  const retainedById = new Map(retainedAssets.map((asset) => [asset.id, asset]));
  return content.media.map((media, index) => {
    if (media.type === 'image-ref' || media.type === 'video-ref') {
      const retained = retainedById.get(media.assetId);
      if (retained) {
        return retained;
      }
      return {
        id: media.assetId,
        type: media.type === 'video-ref' ? 'video' : 'image',
        mimeType: media.type === 'video-ref' ? 'video/mp4' : 'image/jpeg',
        fileName: '',
        sizeBytes: 0,
      };
    }

    return {
      id: `${publicationId}-asset-${index + 1}`,
      type: media.type,
      mimeType: media.mimeType,
      fileName: media.fileName,
      sizeBytes:
        media.type === 'image' || (media.type === 'video' && media.base64)
          ? Math.max(1, Math.floor((media.base64.replace(/=+$/u, '').length * 3) / 4))
          : 0,
    };
  });
}

export function readPreviewScheduleInput(
  schedule: PublicationDetails['schedule'],
): PublicationScheduleInput | null {
  if (!schedule) {
    return null;
  }
  if (schedule.mode === 'now') {
    return { mode: 'now', timezone: schedule.timezone };
  }
  if (schedule.mode === 'once') {
    return {
      mode: 'once',
      timezone: schedule.timezone,
      at: schedule.at,
      replaceConflicts: schedule.replaceConflicts,
    };
  }
  if (schedule.mode === 'slots') {
    return {
      mode: 'slots',
      timezone: schedule.timezone,
      slots: schedule.slots,
      replaceConflicts: schedule.replaceConflicts,
    };
  }
  return {
    mode: 'recurrence',
    timezone: schedule.timezone,
    frequency: schedule.frequency,
    interval: schedule.interval,
    weekdays: schedule.weekdays,
    times: schedule.times,
    startsAt: schedule.startsAt,
    endsAt: schedule.endsAt,
    maxOccurrences: schedule.maxOccurrences,
    replaceConflicts: schedule.replaceConflicts,
  };
}

export function buildPreviewRecurrenceSlots(
  schedule: Extract<PublicationScheduleInput, { mode: 'recurrence' }>,
  now: Date,
): string[] {
  const count = Math.min(4, schedule.maxOccurrences ?? 4);
  const [hours = 10, minutes = 0] = (schedule.times[0] ?? '10:00')
    .split(':')
    .map((value) => Number.parseInt(value, 10));
  const start = schedule.startsAt ? new Date(schedule.startsAt) : addDays(now, 1);
  const safeStart =
    Number.isFinite(start.getTime()) && start.getTime() > now.getTime() ? start : addDays(now, 1);
  safeStart.setUTCHours((hours + 21) % 24, minutes, 0, 0);

  return Array.from({ length: count }, (_, index) => {
    const stepDays = schedule.frequency === 'weekly' ? 7 * schedule.interval : schedule.interval;
    return addDays(safeStart, index * stepDays).toISOString();
  }).filter((slot) => !schedule.endsAt || Date.parse(slot) <= Date.parse(schedule.endsAt));
}

export function buildPreviewPublicationSlots(
  schedule: PublicationScheduleInput | null,
  now: Date,
): string[] {
  if (!schedule) {
    return [];
  }
  if (schedule.mode === 'now') {
    return [now.toISOString()];
  }
  if (schedule.mode === 'once') {
    return [schedule.at];
  }
  if (schedule.mode === 'slots') {
    return schedule.slots;
  }
  return buildPreviewRecurrenceSlots(schedule, now);
}

export function buildPreviewPublicationDetails(
  state: PreviewState,
  request: Omit<CreatePublicationRequest, 'requestId'>,
  options: {
    id: string;
    now?: Date;
    createdAt?: string;
    updatedAt?: string;
    version?: number;
    retainedAssets?: readonly PublicationAsset[];
  },
): { publication: PublicationDetails; deliveries: PublicationDelivery[] } {
  const now = options.now ?? readPreviewClock(state.clock);
  const targets = request.audience.targets.map((target) =>
    resolvePreviewPublicationTarget(state, target),
  );
  const assets = buildPreviewPublicationAssets(options.id, request.content, [
    ...(options.retainedAssets ?? []),
    ...getPreviewUploadedVideos(state),
  ]);
  const slots =
    request.intent === 'publish' ? buildPreviewPublicationSlots(request.schedule, now) : [];
  const occurrences = slots.map((scheduledAt, occurrenceIndex) => ({
    id: `${options.id}-occurrence-${occurrenceIndex + 1}`,
    scheduledAt,
    status: 'SCHEDULED' as const,
    delivery: createEmptyPublicationDeliveryStats(),
    canRetry: false,
    contentRevision: options.version ?? 1,
    usesLatestContent: true,
  }));
  const deliveries = (request.schedule?.mode === 'recurrence' ? [] : occurrences).flatMap(
    (occurrence) =>
      targets.map(
        (target, targetIndex): PublicationDelivery => ({
          id: `${occurrence.id}-delivery-${targetIndex + 1}`,
          occurrenceId: occurrence.id,
          target,
          status: 'PENDING',
          contentRevision: options.version ?? 1,
          usesLatestContent: true,
          attemptCount: 0,
          remoteMessageId: null,
          lastError: null,
          sentAt: null,
        }),
      ),
  );
  const delivery = buildPreviewPublicationDeliveryStats(deliveries);
  const createdAt = options.createdAt ?? now.toISOString();
  const updatedAt = options.updatedAt ?? createdAt;
  const lifecycle = request.intent === 'draft' ? 'DRAFT' : 'ACTIVE';
  const schedule = request.schedule
    ? {
        ...request.schedule,
        conflictConfirmation: undefined,
        status: request.intent === 'draft' ? ('DRAFT' as const) : ('ACTIVE' as const),
        revision: 1,
        nextOccurrenceAt: occurrences[0]?.scheduledAt ?? null,
        lastError: null,
      }
    : null;

  const publication = publicationDetailsSchema.parse({
    postPublish: request.content.postPublish,
    id: options.id,
    title: request.title,
    lifecycle,
    version: options.version ?? 1,
    contentPreview: resolvePublicationContentPreview(request.content),
    contentPreviewFormat: 'plain',
    targetCount: targets.length,
    targetPreviews: targets.slice(0, 6),
    targetOverflowCount: Math.max(0, targets.length - 6),
    audienceSelection: request.audience.selection,
    audienceMode: request.audience.mode,
    mediaCount: assets.length,
    videoCount: assets.filter((asset) => asset.type === 'video').length,
    hasVideo: assets.some((asset) => asset.type === 'video'),
    schedule,
    delivery,
    actionableDelivery: delivery,
    createdAt,
    updatedAt,
    content: {
      revision: options.version ?? 1,
      postPublish: request.content.postPublish,
      text: request.content.text,
      textFormat: request.content.textFormat,
      buttons: request.content.buttons,
      media: assets,
    },
    targets,
    occurrences,
  });
  return { publication, deliveries };
}

export function syncPreviewPublication(
  state: PreviewState,
  publicationId: string,
): PublicationDetails {
  const current = state.publications.find((publication) => publication.id === publicationId);
  if (!current) {
    throw new Error(`Preview publication not found: ${publicationId}`);
  }

  const occurrenceIds = new Set(current.occurrences.map((occurrence) => occurrence.id));
  const publicationDeliveries = state.publicationDeliveries.filter((delivery) =>
    occurrenceIds.has(delivery.occurrenceId),
  );
  const occurrences = current.occurrences.map((occurrence) => {
    const deliveries = publicationDeliveries.filter(
      (delivery) => delivery.occurrenceId === occurrence.id,
    );
    const delivery = buildPreviewPublicationDeliveryStats(deliveries);
    const status =
      occurrence.status === 'CANCELED'
        ? occurrence.status
        : delivery.ambiguous > 0
          ? ('AMBIGUOUS' as const)
          : delivery.failed > 0 && delivery.sent > 0
            ? ('PARTIAL' as const)
            : delivery.failed > 0
              ? ('FAILED' as const)
              : delivery.pending > 0
                ? occurrence.status === 'IN_PROGRESS'
                  ? ('IN_PROGRESS' as const)
                  : ('SCHEDULED' as const)
                : delivery.sent > 0
                  ? ('SENT' as const)
                  : occurrence.status;
    return {
      ...occurrence,
      status,
      delivery,
      canRetry:
        status !== 'CANCELED' &&
        (delivery.failed > 0 ||
          (occurrence.requiresScheduleDecision === true && status === 'FAILED')),
    };
  });
  const nextOccurrenceAt =
    occurrences
      .filter(
        (occurrence) => occurrence.status === 'SCHEDULED' || occurrence.status === 'IN_PROGRESS',
      )
      .sort((left, right) => Date.parse(left.scheduledAt) - Date.parse(right.scheduledAt))[0]
      ?.scheduledAt ?? null;
  const actionableOccurrence =
    occurrences.find(
      (occurrence) =>
        occurrence.status === 'FAILED' ||
        occurrence.status === 'PARTIAL' ||
        occurrence.status === 'AMBIGUOUS' ||
        occurrence.status === 'IN_PROGRESS',
    ) ??
    occurrences.find((occurrence) => occurrence.status === 'SCHEDULED') ??
    occurrences.at(-1);
  const publication = publicationDetailsSchema.parse({
    ...current,
    schedule: current.schedule
      ? {
          ...current.schedule,
          nextOccurrenceAt,
        }
      : null,
    delivery: buildPreviewPublicationDeliveryStats(publicationDeliveries),
    actionableDelivery: {
      ...(actionableOccurrence?.delivery ?? createEmptyPublicationDeliveryStats()),
      dispatchPending: publicationDeliveries.filter(
        (delivery) =>
          delivery.occurrenceId === actionableOccurrence?.id &&
          actionableOccurrence.status !== 'CANCELED' &&
          delivery.dispatchStopped !== true &&
          (delivery.status === 'PENDING' || delivery.status === 'SENDING'),
      ).length,
    },
    occurrences,
  });
  state.publications = state.publications.map((item) =>
    item.id === publicationId ? publication : item,
  );
  return publication;
}

export function createPreviewPublications(
  state: PreviewState,
  now: Date,
): { publications: PublicationDetails[]; deliveries: PublicationDelivery[] } {
  const fixtures: Array<{
    request: Omit<CreatePublicationRequest, 'requestId'>;
    id: string;
    createdAt: string;
  }> = [
    {
      id: 'publication-neighborhood-digest',
      createdAt: addDays(now, -6).toISOString(),
      request: {
        title: 'Утренний дайджест',
        content: {
          text: '**Доброе утро!** Собрали главные новости района и полезные объявления.',
          textFormat: 'markdown',
          buttons: [{ text: 'Открыть дайджест', url: 'https://max.ru/', row: 0 }],
          media: [],
        },
        audience: {
          selection: 'SELECTED',
          mode: 'SNAPSHOT',
          targets: [
            { chatId: PREVIEW_CHAT_ID, entityType: 'chat' },
            { chatId: PREVIEW_CHANNEL_ID, entityType: 'channel' },
          ],
        },
        schedule: {
          mode: 'recurrence',
          timezone: 'Europe/Moscow',
          frequency: 'weekly',
          interval: 1,
          weekdays: [1, 3, 5],
          times: ['09:00'],
          startsAt: addHours(now, 3).toISOString(),
          endsAt: null,
          maxOccurrences: 30,
          replaceConflicts: false,
        },
        intent: 'publish',
      },
    },
    {
      id: 'publication-weekend-events',
      createdAt: addDays(now, -3).toISOString(),
      request: {
        title: 'Афиша выходных',
        content: {
          text: 'В субботу встречаемся на набережной. Начало в 12:00.',
          textFormat: 'markdown',
          buttons: [],
          media: [],
        },
        audience: {
          selection: 'SELECTED',
          mode: 'SNAPSHOT',
          targets: [{ chatId: 'preview-channel-2', entityType: 'channel' }],
        },
        schedule: {
          mode: 'slots',
          timezone: 'Europe/Moscow',
          slots: [addDays(now, 2).toISOString(), addDays(now, 9).toISOString()],
          replaceConflicts: false,
        },
        intent: 'publish',
      },
    },
    {
      id: 'publication-delivery-review',
      createdAt: addDays(now, -2).toISOString(),
      request: {
        title: 'Важное объявление',
        content: {
          text: 'Проверьте новый порядок въезда во двор с понедельника.',
          textFormat: 'markdown',
          buttons: [],
          media: [],
        },
        audience: {
          selection: 'SELECTED',
          mode: 'SNAPSHOT',
          targets: [{ chatId: 'preview-chat-2', entityType: 'chat' }],
        },
        schedule: { mode: 'now', timezone: 'Europe/Moscow' },
        intent: 'publish',
      },
    },
    {
      id: 'publication-completed',
      createdAt: addDays(now, -8).toISOString(),
      request: {
        title: 'Итоги недели',
        content: {
          text: 'Спасибо всем, кто участвовал в субботнике. Фото уже в канале.',
          textFormat: 'markdown',
          buttons: [],
          media: [],
        },
        audience: {
          selection: 'SELECTED',
          mode: 'SNAPSHOT',
          targets: [{ chatId: PREVIEW_CHANNEL_ID, entityType: 'channel' }],
        },
        schedule: { mode: 'now', timezone: 'Europe/Moscow' },
        intent: 'publish',
      },
    },
  ];

  if (state.me.profile === 'publisher') {
    fixtures.splice(2, 0, {
      id: 'publication-access-required',
      createdAt: addDays(now, -1).toISOString(),
      request: {
        title: 'Объявление для канала',
        content: {
          text: 'Важная информация для подписчиков.',
          textFormat: 'markdown',
          buttons: [],
          media: [],
        },
        audience: {
          selection: 'SELECTED',
          mode: 'SNAPSHOT',
          targets: [{ chatId: PREVIEW_CHANNEL_ID, entityType: 'channel' }],
        },
        schedule: { mode: 'now', timezone: 'Europe/Moscow' },
        intent: 'publish',
      },
    });
  }

  const built = fixtures.map((fixture) =>
    buildPreviewPublicationDetails(state, fixture.request, {
      id: fixture.id,
      now,
      createdAt: fixture.createdAt,
      updatedAt: fixture.createdAt,
    }),
  );
  const accessRequiredFixture = built.find(
    ({ publication }) => publication.id === 'publication-access-required',
  );
  if (accessRequiredFixture) {
    const accessRequired = accessRequiredFixture.publication;
    const emptyDelivery = createEmptyPublicationDeliveryStats();
    accessRequiredFixture.deliveries.length = 0;
    accessRequired.dispatchIssue = 'actor_access_required';
    accessRequired.delivery = emptyDelivery;
    accessRequired.actionableDelivery = emptyDelivery;
    const occurrence = accessRequired.occurrences[0];
    if (occurrence) {
      occurrence.status = 'IN_PROGRESS';
      occurrence.dispatchIssue = 'actor_access_required';
      occurrence.dispatchBlockedSince = addHours(now, -4).toISOString();
      occurrence.dispatchCheckedAt = addHours(now, -1).toISOString();
      occurrence.delivery = emptyDelivery;
    }
  }

  const publications = built.map((item) => item.publication);
  const deliveries = built.flatMap((item) => item.deliveries);

  const paused = publications.find(
    (publication) => publication.id === 'publication-weekend-events',
  );
  if (paused?.schedule) {
    paused.lifecycle = 'PAUSED';
    paused.schedule.status = 'PAUSED';
  }
  const ambiguous = deliveries.find((delivery) =>
    delivery.occurrenceId.startsWith('publication-delivery-review-'),
  );
  if (ambiguous) {
    ambiguous.status = 'AMBIGUOUS';
    ambiguous.usesLatestContent = false;
    ambiguous.attemptCount = 1;
    ambiguous.lastError = 'MAX принял запрос, но ответ не получен.';
  }
  const review = publications.find(
    (publication) => publication.id === 'publication-delivery-review',
  );
  if (review) {
    review.lifecycle = 'ERROR';
    review.version = 2;
    review.content.revision = 2;
    const reviewOccurrence = review.occurrences[0];
    if (reviewOccurrence) {
      reviewOccurrence.contentRevision = 1;
      reviewOccurrence.usesLatestContent = false;
    }
  }
  const completed = publications.find((publication) => publication.id === 'publication-completed');
  if (completed) {
    completed.lifecycle = 'COMPLETED';
    if (completed.schedule) {
      completed.schedule.status = 'COMPLETED';
      completed.schedule.nextOccurrenceAt = null;
    }
    for (const delivery of deliveries.filter((item) =>
      item.occurrenceId.startsWith('publication-completed-'),
    )) {
      delivery.status = 'SENT';
      delivery.attemptCount = 1;
      delivery.remoteMessageId = 'preview-message-completed';
      delivery.sentAt = addDays(now, -8).toISOString();
      delivery.postActions = {
        version: '0'.repeat(64),
        busy: false,
        allowedActions: ['reschedule_delete'],
        pinStatus: 'NONE',
        pinError: null,
        deleteStatus: 'NONE',
        deleteAt: null,
        deletedAt: null,
        deleteError: null,
      };
    }
  }

  const previousPublications = state.publications;
  const previousDeliveries = state.publicationDeliveries;
  state.publications = publications;
  state.publicationDeliveries = deliveries;
  for (const publication of publications) {
    syncPreviewPublication(state, publication.id);
  }
  const result = {
    publications: state.publications,
    deliveries: state.publicationDeliveries,
  };
  state.publications = previousPublications;
  state.publicationDeliveries = previousDeliveries;
  return result;
}

export function throwPreviewPublicationError(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export function assertPreviewPublicationRevision(
  publication: PublicationDetails,
  expectedRevision: number,
): void {
  if (publication.version !== expectedRevision) {
    throwPreviewPublicationError(
      'PUBLICATION_REVISION_CONFLICT',
      'Публикация уже изменилась. Обновите экран и повторите.',
    );
  }
}

function assertPreviewPublicationScheduleAvailability(
  state: PreviewState,
  request: Pick<CreatePublicationRequest, 'audience' | 'schedule' | 'intent'>,
  excludedPublicationId: string | null = null,
): void {
  confirmPreviewCalendarReplacement(
    state,
    request,
    excludedPublicationId,
    buildPreviewPublicationSlots,
    () => readPreviewClock(state.clock),
    (id) => syncPreviewPublication(state, id),
  );
}

export function buildPreviewPublicationContentInput(
  publication: PublicationDetails,
): PublicationContentInput {
  return {
    postPublish: publication.content.postPublish,
    text: publication.content.text,
    textFormat: publication.content.textFormat,
    buttons: publication.content.buttons,
    media: publication.content.media.map((asset) => ({
      type: asset.type === 'video' ? ('video-ref' as const) : ('image-ref' as const),
      assetId: asset.id,
    })),
  };
}

export function replacePreviewPublication(
  state: PreviewState,
  current: PublicationDetails | null,
  request: Omit<CreatePublicationRequest, 'requestId'>,
): PublicationDetails {
  const id =
    current?.id ??
    `publication-preview-${readPreviewClock(state.clock).getTime()}-${state.publications.length + 1}`;
  const built = buildPreviewPublicationDetails(state, request, {
    id,
    version: current ? current.version + 1 : 1,
    createdAt: current?.createdAt,
    updatedAt: readPreviewClock(state.clock).toISOString(),
    retainedAssets: current?.content.media,
  });
  if (current) {
    const oldOccurrenceIds = new Set(current.occurrences.map((occurrence) => occurrence.id));
    state.publicationDeliveries = state.publicationDeliveries.filter(
      (delivery) => !oldOccurrenceIds.has(delivery.occurrenceId),
    );
    state.publications = state.publications.map((publication) =>
      publication.id === current.id ? built.publication : publication,
    );
  } else {
    state.publications = [built.publication, ...state.publications];
  }
  state.publicationDeliveries.push(...built.deliveries);
  return syncPreviewPublication(state, id);
}

export function resolvePreviewLegacyContentPreview(
  text: string,
  imageCount: number,
  hasVideo: boolean,
): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (normalized) {
    return normalized.slice(0, 160);
  }
  if (hasVideo) {
    return 'Видео без текста';
  }
  if (imageCount > 0) {
    return 'Фото без текста';
  }
  return 'Пустая публикация';
}

export function buildPreviewLegacyPublicationItems(
  state: PreviewState,
): LegacyPublicationSummary[] {
  const autopostItems = state.autopostRules.flatMap((rule): LegacyPublicationSummary[] => {
    if (rule.status === 'DISABLED') {
      return [];
    }
    const source = resolvePreviewSource(state, rule.entityType, rule.sourceChatId);
    const hasVideo = rule.hasVideo || rule.payload.mediaType === 'video';
    const imageCount = rule.imageCount || rule.payload.images.length || (rule.hasImage ? 1 : 0);

    return [
      {
        kind: 'autopost',
        id: rule.id,
        source: {
          chatId: rule.sourceChatId,
          entityType: rule.entityType,
          title: source?.title ?? rule.sourcePreview.title,
          avatarUrl: source?.avatarUrl ?? rule.sourcePreview.avatarUrl ?? null,
          link: source?.link?.trim() || rule.sourcePreview.link?.trim() || null,
        },
        status: rule.status,
        title: rule.title.trim(),
        contentPreview: resolvePreviewLegacyContentPreview(rule.payload.text, imageCount, hasVideo),
        targetCount: Math.max(1, rule.targetChats),
        mediaCount: hasVideo ? 1 : imageCount,
        hasVideo,
        scheduleTimezone: rule.scheduleTimezone,
        nextRunAt: rule.nextSendAt,
        createdAt: rule.createdAt,
        updatedAt: rule.updatedAt,
        lastError: rule.lastError?.trim() || null,
      },
    ];
  });

  const mapBroadcasts = (
    broadcasts: ManagedBroadcastDetails[],
    entityType: ManagedEntityType,
    sourceChatId: string,
  ): LegacyPublicationSummary[] => {
    const source = resolvePreviewSource(state, entityType, sourceChatId);
    return broadcasts.flatMap((broadcast): LegacyPublicationSummary[] => {
      const publicationOccurrenceId = (
        broadcast as ManagedBroadcastDetails & { publicationOccurrenceId?: unknown }
      ).publicationOccurrenceId;
      if (broadcast.autopostRuleId || publicationOccurrenceId) {
        return [];
      }
      const hasVideo = broadcast.mediaType === 'video';
      const imageCount =
        broadcast.images.length ||
        (broadcast.imageEnabled || broadcast.mediaType === 'image' ? 1 : 0);
      const targetCount = broadcast.applyToAllChats
        ? Math.max(1, state.chats.length)
        : Math.max(1, new Set(broadcast.targetChatIds.map((id) => id.trim()).filter(Boolean)).size);

      return [
        {
          kind: 'broadcast',
          id: broadcast.id,
          source: {
            chatId: sourceChatId,
            entityType,
            title:
              source?.title ??
              (entityType === 'channel' ? PREVIEW_CHANNEL_TITLE : PREVIEW_CHAT_TITLE),
            avatarUrl: source?.avatarUrl ?? null,
            link: source?.link?.trim() || null,
          },
          status: broadcast.status,
          title: '',
          contentPreview: resolvePreviewLegacyContentPreview(broadcast.text, imageCount, hasVideo),
          targetCount,
          mediaCount: hasVideo ? 1 : imageCount,
          hasVideo,
          scheduleTimezone: broadcast.scheduleTimezone,
          nextRunAt: broadcast.nextSendAt,
          createdAt: broadcast.createdAt,
          updatedAt: broadcast.updatedAt,
          lastError: broadcast.lastError?.trim() || null,
        },
      ];
    });
  };

  return [
    ...autopostItems,
    ...mapBroadcasts(state.chatBroadcasts, 'chat', PREVIEW_CHAT_ID),
    ...mapBroadcasts(state.channelBroadcasts, 'channel', PREVIEW_CHANNEL_ID),
  ];
}

export function handleLegacyPublicationsRequest(state: PreviewState, url: URL) {
  const query = listLegacyPublicationsQuerySchema.parse(Object.fromEntries(url.searchParams));
  const cursor = query.cursor ? decodeLegacyPublicationListCursor(query.cursor) : null;
  if (
    query.cursor &&
    (!cursor ||
      cursor.view !== query.view ||
      cursor.kind !== query.kind ||
      cursor.entityType !== query.entityType ||
      cursor.query !== query.query)
  ) {
    throw new Error('Preview legacy publication cursor is invalid.');
  }

  const normalizedQuery = query.query.toLocaleLowerCase('ru-RU');
  const matchesView = (item: LegacyPublicationSummary) =>
    item.kind === 'autopost'
      ? query.view === 'active'
        ? item.status === 'ACTIVE' || item.status === 'PAUSED' || item.status === 'ERROR'
        : item.status === 'COMPLETED'
      : query.view === 'active'
        ? item.status === 'ACTIVE' || item.status === 'PARTIAL' || item.status === 'FAILED'
        : item.status === 'COMPLETED' || item.status === 'CANCELED';
  const filtered = buildPreviewLegacyPublicationItems(state)
    .filter(matchesView)
    .filter((item) => query.kind === 'all' || item.kind === query.kind)
    .filter((item) => !query.entityType || item.source.entityType === query.entityType)
    .filter((item) => {
      if (!normalizedQuery) {
        return true;
      }
      return [item.title, item.contentPreview, item.source.title].some((value) =>
        value.toLocaleLowerCase('ru-RU').includes(normalizedQuery),
      );
    })
    .sort((left, right) => {
      const updatedAtDifference = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      if (updatedAtDifference !== 0) {
        return updatedAtDifference;
      }
      const idDifference = right.id.localeCompare(left.id);
      return idDifference !== 0 ? idDifference : right.kind.localeCompare(left.kind);
    });
  const afterCursor = cursor
    ? filtered.filter((item) => {
        const updatedAt = Date.parse(item.updatedAt);
        const cursorUpdatedAt = Date.parse(cursor.updatedAt);
        if (updatedAt !== cursorUpdatedAt) {
          return updatedAt < cursorUpdatedAt;
        }
        const idDifference = item.id.localeCompare(cursor.id);
        return idDifference !== 0 ? idDifference < 0 : item.kind.localeCompare(cursor.itemKind) < 0;
      })
    : filtered;
  const page = afterCursor.slice(0, query.limit);
  const last = page.at(-1);

  return listLegacyPublicationsResponseSchema.parse({
    items: page,
    nextCursor:
      page.length < afterCursor.length && last
        ? encodeLegacyPublicationListCursor({
            v: 1,
            updatedAt: last.updatedAt,
            id: last.id,
            itemKind: last.kind,
            view: query.view,
            kind: query.kind,
            entityType: query.entityType,
            query: query.query,
          })
        : null,
    totalCount: filtered.length,
  });
}

export function handlePublicationsRequest(
  state: PreviewState,
  segments: string[],
  url: URL,
  method: string,
  init: RequestInit,
) {
  if (segments.length === 2 && segments[1] === 'legacy' && method === 'GET') {
    return handleLegacyPublicationsRequest(state, url);
  }

  if (segments.length === 2 && segments[1] === 'calendar-availability' && method === 'POST') {
    const payload = publicationCalendarAvailabilityRequestSchema.parse(parseJsonBody(init));
    const requestedTargets = new Set(
      payload.audience.targets.map((target) => `${target.entityType}:${target.chatId}`),
    );
    const from = Date.parse(payload.from);
    const to = Date.parse(payload.to);
    const slots = new Map<string, Set<string>>();
    for (const candidate of state.publications) {
      if (
        candidate.id === payload.excludePublicationId ||
        candidate.lifecycle === 'COMPLETED' ||
        candidate.lifecycle === 'CANCELED'
      ) {
        continue;
      }
      const matchingTargets = candidate.targets.filter((target) =>
        requestedTargets.has(`${target.entityType}:${target.chatId}`),
      );
      if (matchingTargets.length === 0) {
        continue;
      }
      for (const occurrence of candidate.occurrences) {
        const scheduledAt = Date.parse(occurrence.scheduledAt);
        if (
          !Number.isFinite(scheduledAt) ||
          scheduledAt < from ||
          scheduledAt > to ||
          (occurrence.status !== 'SCHEDULED' && occurrence.status !== 'IN_PROGRESS')
        ) {
          continue;
        }
        const targetSet = slots.get(occurrence.scheduledAt) ?? new Set<string>();
        for (const target of matchingTargets) {
          targetSet.add(`${target.entityType}:${target.chatId}`);
        }
        slots.set(occurrence.scheduledAt, targetSet);
      }
    }
    return publicationCalendarAvailabilityResponseSchema.parse({
      from: payload.from,
      to: payload.to,
      slots: [...slots.entries()]
        .sort(([left], [right]) => Date.parse(left) - Date.parse(right))
        .map(([scheduledAt, targetSet]) => ({ scheduledAt, targetCount: targetSet.size })),
    });
  }

  if (segments.length === 1) {
    if (method === 'GET') {
      const query = listPublicationsQuerySchema.parse(Object.fromEntries(url.searchParams));
      const cursor = query.cursor ? decodePublicationListCursor(query.cursor) : null;
      if (
        query.cursor &&
        (!cursor ||
          cursor.view !== query.view ||
          cursor.query !== query.query ||
          cursor.entityType !== query.entityType ||
          cursor.status !== query.status)
      ) {
        throw new Error('Preview publication cursor is invalid.');
      }
      const lifecycleMatches = (publication: PublicationDetails) =>
        query.view === 'drafts'
          ? publication.lifecycle === 'DRAFT'
          : query.view === 'history'
            ? publication.lifecycle === 'COMPLETED' || publication.lifecycle === 'CANCELED'
            : publication.lifecycle === 'ACTIVE' ||
              publication.lifecycle === 'PAUSED' ||
              publication.lifecycle === 'ERROR';
      const scheduleMatches = (publication: PublicationDetails) =>
        query.view === 'current'
          ? publication.schedule?.mode === 'now'
          : query.view !== 'schedules' ||
            publication.schedule?.mode === 'once' ||
            publication.schedule?.mode === 'slots' ||
            publication.schedule?.mode === 'recurrence';
      const entityMatches = (publication: PublicationDetails) => {
        if (!query.entityType || publication.audienceSelection === 'ALL_MANAGED') {
          return true;
        }
        if (query.entityType === 'chat' && publication.audienceSelection === 'ALL_CHATS') {
          return true;
        }
        if (query.entityType === 'channel' && publication.audienceSelection === 'ALL_CHANNELS') {
          return true;
        }
        return publication.targets.some((target) => target.entityType === query.entityType);
      };
      const statusMatches = (publication: PublicationDetails) => {
        if (!query.status) {
          return true;
        }
        const delivery = publication.actionableDelivery ?? publication.delivery;
        if (query.status === 'active') {
          return publication.lifecycle === 'ACTIVE';
        }
        if (query.status === 'paused') {
          return publication.lifecycle === 'PAUSED';
        }
        if (query.status === 'completed') {
          return publication.lifecycle === 'COMPLETED' || publication.lifecycle === 'CANCELED';
        }
        return publication.lifecycle === 'ERROR' || delivery.failed > 0 || delivery.ambiguous > 0;
      };
      const normalizedQuery = query.query.toLocaleLowerCase('ru-RU');
      const filtered = state.publications
        .filter(lifecycleMatches)
        .filter(scheduleMatches)
        .filter(entityMatches)
        .filter(statusMatches)
        .filter((publication) => {
          if (!normalizedQuery) {
            return true;
          }
          return [
            publication.title,
            publication.content.text,
            ...publication.targets.map((target) => target.title),
          ].some((value) => value.toLocaleLowerCase('ru-RU').includes(normalizedQuery));
        })
        .sort((left, right) => {
          const updatedAtDifference = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
          if (updatedAtDifference !== 0) {
            return updatedAtDifference;
          }
          if (left.id === right.id) {
            return 0;
          }
          return left.id < right.id ? 1 : -1;
        })
        .filter((publication) => {
          if (!cursor) {
            return true;
          }
          const updatedAt = Date.parse(publication.updatedAt);
          const cursorUpdatedAt = Date.parse(cursor.updatedAt);
          return (
            updatedAt < cursorUpdatedAt ||
            (updatedAt === cursorUpdatedAt && publication.id < cursor.id)
          );
        });
      const page = filtered.slice(0, query.limit);
      const last = page.at(-1);
      return listPublicationsResponseSchema.parse({
        items: page,
        nextCursor:
          page.length < filtered.length && last
            ? encodePublicationListCursor({
                v: 1,
                updatedAt: last.updatedAt,
                id: last.id,
                view: query.view,
                query: query.query,
                entityType: query.entityType,
                status: query.status,
              })
            : null,
      });
    }

    if (method === 'POST') {
      const payload = createPublicationRequestSchema.parse(parseJsonBody(init));
      assertPreviewPublicationScheduleAvailability(state, payload);
      return cloneJson(replacePreviewPublication(state, null, payload));
    }
  }

  if (segments.length === 2 && segments[1] === 'test' && method === 'POST') {
    testPublicationRequestSchema.parse(parseJsonBody(init));
    return null;
  }

  const publicationId = segments[1] ? decodeURIComponent(segments[1]) : '';
  const publication = state.publications.find((item) => item.id === publicationId);
  if (!publication) {
    throw new Error(`Preview publication not found: ${publicationId}`);
  }

  if (segments.length === 2 && method === 'GET') {
    return cloneJson(syncPreviewPublication(state, publicationId));
  }

  if (
    segments.length === 5 &&
    segments[2] === 'deliveries' &&
    segments[4] === 'post-actions' &&
    method === 'POST'
  ) {
    const request = publicationPostActionRequestSchema.parse(parseJsonBody(init));
    const delivery = state.publicationDeliveries.find(
      (row) =>
        row.id === decodeURIComponent(segments[3]!) &&
        publication.occurrences.some((occurrence) => occurrence.id === row.occurrenceId),
    );
    const current = delivery?.postActions;
    if (!delivery || !current?.version || delivery.status !== 'SENT')
      throw new Error('Доставка не найдена.');
    const key = `${publication.id}:${delivery.id}:${request.requestId}`;
    const fingerprint = JSON.stringify(request);
    const requests = previewPostActionRequests.get(state) ?? new Map<string, string>();
    previewPostActionRequests.set(state, requests);
    const prior = requests.get(key);
    if (prior) {
      if (prior !== fingerprint) throw new Error('Идентификатор запроса уже использован.');
      return cloneJson(current);
    }
    if (
      current.version !== request.expectedVersion ||
      current.busy ||
      !current.allowedActions?.includes(request.action)
    )
      throwPreviewPublicationError(
        'PUBLICATION_REVISION_CONFLICT',
        'Состояние поста изменилось. Обновите его.',
      );
    const next: PublicationPostActions = {
      ...current,
      version: (BigInt(`0x${current.version}`) + 1n).toString(16).padStart(64, '0'),
    };
    if (request.action === 'reschedule_delete') {
      const delay = Date.parse(request.deleteAt) - Date.now();
      if (delay < 30_000 || delay > 30 * 24 * 3_600_000)
        throw new Error('Выберите время удаления от 30 секунд до 30 дней в будущем.');
      Object.assign(next, {
        deleteStatus: 'PENDING',
        deleteAt: request.deleteAt,
        deleteError: null,
      });
    } else if (request.action === 'cancel_delete')
      Object.assign(next, { deleteStatus: 'SKIPPED', deleteAt: null, deleteError: null });
    else if (request.action === 'retry_pin')
      Object.assign(next, { pinStatus: 'DONE', pinError: null });
    else
      Object.assign(next, {
        deleteStatus: 'DONE',
        deletedAt: new Date().toISOString(),
        deleteError: null,
      });
    next.allowedActions =
      next.deleteStatus === 'DONE'
        ? []
        : [
            'reschedule_delete',
            ...(next.deleteStatus === 'PENDING' ? ['cancel_delete' as const] : []),
            ...(next.deleteStatus === 'FAILED' ? ['retry_delete' as const] : []),
            ...(next.pinStatus === 'FAILED' ? ['retry_pin' as const] : []),
          ];
    delivery.postActions = next;
    requests.set(key, fingerprint);
    return cloneJson(next);
  }

  if (
    segments.length === 4 &&
    segments[2] === 'targets' &&
    segments[3] === 'refresh' &&
    method === 'POST'
  ) {
    publication.dispatchIssue = null;
    publication.occurrences = publication.occurrences.map((occurrence) => ({
      ...occurrence,
      dispatchIssue: null,
    }));
    return publicationTargetsRefreshResponseSchema.parse({
      accepted: true,
      queuedCount: publication.targets.length,
      operationId: recordPreviewPublisherRefresh(state, publication.targets.length),
    });
  }

  if (segments.length === 2 && method === 'PUT') {
    const payload = updatePublicationRequestSchema.parse(parseJsonBody(init));
    assertPreviewPublicationRevision(publication, payload.expectedRevision);
    const audience = payload.audience ?? {
      selection: publication.audienceSelection,
      mode: publication.audienceMode,
      targets: publication.targets.map((target) => ({
        chatId: target.chatId,
        entityType: target.entityType,
      })),
    };
    const request: Omit<CreatePublicationRequest, 'requestId'> = {
      title: payload.title ?? publication.title,
      content: payload.content ?? buildPreviewPublicationContentInput(publication),
      audience,
      schedule:
        payload.schedule === undefined
          ? readPreviewScheduleInput(publication.schedule)
          : payload.schedule,
      intent: payload.intent ?? (publication.lifecycle === 'DRAFT' ? 'draft' : 'publish'),
    };
    assertPreviewPublicationScheduleAvailability(state, request, publication.id);
    return cloneJson(replacePreviewPublication(state, publication, request));
  }

  if (segments.length === 2 && method === 'DELETE') {
    const payload = publicationActionRequestSchema.parse(parseJsonBody(init));
    assertPreviewPublicationRevision(publication, payload.expectedRevision);
    publication.lifecycle = 'CANCELED';
    publication.version += 1;
    publication.updatedAt = readPreviewClock(state.clock).toISOString();
    if (publication.schedule) {
      publication.schedule.status = 'CANCELED';
      publication.schedule.nextOccurrenceAt = null;
      publication.schedule.revision += 1;
    }
    const occurrenceIds = new Set(publication.occurrences.map((occurrence) => occurrence.id));
    for (const delivery of state.publicationDeliveries) {
      if (
        occurrenceIds.has(delivery.occurrenceId) &&
        (delivery.status === 'PENDING' || delivery.status === 'SENDING')
      ) {
        delivery.status = 'CANCELED';
      }
    }
    for (const occurrence of publication.occurrences) {
      if (occurrence.status === 'SCHEDULED' || occurrence.status === 'IN_PROGRESS') {
        occurrence.status = 'CANCELED';
      }
    }
    return cloneJson(syncPreviewPublication(state, publicationId));
  }

  if (segments[2] === 'occurrences' && segments[4] === 'skip' && method === 'POST') {
    const request = publicationActionRequestSchema.parse(parseJsonBody(init));
    assertPreviewPublicationRevision(publication, request.expectedRevision);
    const occurrenceId = decodeURIComponent(segments[3] ?? '');
    const occurrence = publication.occurrences.find((item) => item.id === occurrenceId);
    if (
      !occurrence ||
      occurrence.status !== 'SCHEDULED' ||
      publication.schedule?.mode !== 'recurrence' ||
      publication.lifecycle !== 'ACTIVE' ||
      Date.parse(occurrence.scheduledAt) <= readPreviewClock(state.clock).getTime()
    ) {
      throw new Error('Этот выпуск уже изменился или начал отправляться.');
    }
    occurrence.status = 'CANCELED';
    occurrence.skippedByEditor = true;
    for (const delivery of state.publicationDeliveries) {
      if (delivery.occurrenceId === occurrence.id && delivery.status === 'PENDING')
        delivery.status = 'CANCELED';
    }
    publication.version += 1;
    publication.updatedAt = readPreviewClock(state.clock).toISOString();
    return cloneJson(syncPreviewPublication(state, publication.id));
  }

  if (segments[2] === 'occurrences' && segments[4] === 'reschedule' && method === 'POST') {
    const request = publicationOccurrenceRescheduleRequestSchema.parse(parseJsonBody(init));
    const occurrenceId = decodeURIComponent(segments[3] ?? '');
    return reschedulePreviewPublication(state, publication, occurrenceId, request, {
      buildPreviewPublicationContentInput,
      buildPreviewPublicationDetails,
      assertPreviewPublicationScheduleAvailability,
      syncPreviewPublication,
    });
  }

  if (segments[2] === 'deliveries' && segments.length === 3 && method === 'GET') {
    const query = listPublicationDeliveriesQuerySchema.parse(Object.fromEntries(url.searchParams));
    const occurrenceIds = new Set(publication.occurrences.map((occurrence) => occurrence.id));
    const filtered = state.publicationDeliveries.filter(
      (delivery) =>
        occurrenceIds.has(delivery.occurrenceId) &&
        (!query.occurrenceId || delivery.occurrenceId === query.occurrenceId) &&
        (!query.status || delivery.status === query.status) &&
        (!query.excludeStatus || delivery.status !== query.excludeStatus),
    );
    const cursorIndex = query.cursor
      ? filtered.findIndex((delivery) => delivery.id === query.cursor)
      : -1;
    const pageStart = cursorIndex >= 0 ? cursorIndex + 1 : 0;
    const page = filtered.slice(pageStart, pageStart + query.limit);
    return listPublicationDeliveriesResponseSchema.parse({
      items: page,
      nextCursor: pageStart + page.length < filtered.length ? (page.at(-1)?.id ?? null) : null,
    });
  }

  if (
    segments.length === 3 &&
    (segments[2] === 'pause' || segments[2] === 'resume' || segments[2] === 'cancel') &&
    method === 'POST'
  ) {
    const payload = publicationActionRequestSchema.parse(parseJsonBody(init));
    assertPreviewPublicationRevision(publication, payload.expectedRevision);
    publication.version += 1;
    publication.updatedAt = readPreviewClock(state.clock).toISOString();
    if (segments[2] === 'pause') {
      publication.lifecycle = 'PAUSED';
      if (publication.schedule) {
        publication.schedule.status = 'PAUSED';
        publication.schedule.revision += 1;
      }
    } else if (segments[2] === 'resume') {
      publication.lifecycle = 'ACTIVE';
      if (publication.schedule) {
        publication.schedule.status = 'ACTIVE';
        publication.schedule.revision += 1;
      }
    } else {
      publication.lifecycle = 'CANCELED';
      if (publication.schedule) {
        publication.schedule.status = 'CANCELED';
        publication.schedule.nextOccurrenceAt = null;
        publication.schedule.revision += 1;
      }
      const occurrenceIds = new Set(publication.occurrences.map((occurrence) => occurrence.id));
      for (const delivery of state.publicationDeliveries) {
        if (
          occurrenceIds.has(delivery.occurrenceId) &&
          (delivery.status === 'PENDING' || delivery.status === 'SENDING')
        ) {
          delivery.status = 'CANCELED';
        }
      }
      for (const occurrence of publication.occurrences) {
        if (occurrence.status === 'SCHEDULED' || occurrence.status === 'IN_PROGRESS') {
          occurrence.status = 'CANCELED';
        }
      }
    }
    return cloneJson(syncPreviewPublication(state, publicationId));
  }

  if (
    segments.length === 5 &&
    segments[2] === 'occurrences' &&
    segments[4] === 'retry' &&
    method === 'POST'
  ) {
    const payload = retryPublicationOccurrenceRequestSchema.parse(parseJsonBody(init));
    const occurrenceId = decodeURIComponent(segments[3] ?? '');
    const occurrence = publication.occurrences.find((item) => item.id === occurrenceId);
    if (!occurrence) {
      throw new Error(`Preview publication occurrence not found: ${occurrenceId}`);
    }
    if (payload.contentMode === 'latest') {
      occurrence.contentRevision = publication.content.revision;
      occurrence.usesLatestContent = true;
    }
    for (const delivery of state.publicationDeliveries) {
      if (delivery.occurrenceId === occurrenceId && delivery.status === 'FAILED') {
        if (payload.contentMode === 'latest') {
          delivery.contentRevision = publication.content.revision;
          delivery.usesLatestContent = true;
        }
        delivery.status = 'SENT';
        delivery.attemptCount += 1;
        delivery.remoteMessageId = `preview-retry-${readPreviewClock(state.clock).getTime()}`;
        delivery.lastError = null;
        delivery.sentAt = readPreviewClock(state.clock).toISOString();
      }
    }
    publication.updatedAt = readPreviewClock(state.clock).toISOString();
    return cloneJson(syncPreviewPublication(state, publicationId));
  }

  if (
    segments.length === 5 &&
    segments[2] === 'occurrences' &&
    segments[4] === 'resolve-ambiguous' &&
    method === 'POST'
  ) {
    const payload = resolvePublicationAmbiguousDeliveryRequestSchema.parse(parseJsonBody(init));
    const occurrenceId = decodeURIComponent(segments[3] ?? '');
    const delivery = state.publicationDeliveries.find(
      (item) =>
        item.id === payload.deliveryId &&
        item.occurrenceId === occurrenceId &&
        item.status === 'AMBIGUOUS',
    );
    if (!delivery) {
      throw new Error(`Preview ambiguous delivery not found: ${payload.deliveryId}`);
    }
    if (payload.resolution === 'mark_sent') {
      delivery.status = 'SENT';
      delivery.remoteMessageId =
        delivery.remoteMessageId ?? `preview-resolved-${readPreviewClock(state.clock).getTime()}`;
      delivery.sentAt = delivery.sentAt ?? readPreviewClock(state.clock).toISOString();
      delivery.lastError = null;
    } else {
      delivery.status = 'FAILED';
      delivery.lastError = 'Отмечено как неотправленное.';
    }
    publication.updatedAt = readPreviewClock(state.clock).toISOString();
    return cloneJson(syncPreviewPublication(state, publicationId));
  }

  throw new Error(`Preview transport does not implement ${method} ${url.pathname}`);
}

export const handlePublicationsPreviewRequest: PreviewRequestHandler = (context) => {
  const video = handlePublicationVideoPreviewRequest(context);
  if (video !== PREVIEW_NOT_HANDLED) return video;
  if (context.segments[0] !== 'publications') {
    return PREVIEW_NOT_HANDLED;
  }
  return handlePublicationsRequest(
    context.state,
    context.segments,
    context.url,
    context.method,
    context.init,
  );
};
