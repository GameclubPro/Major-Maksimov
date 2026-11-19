import {
  managedGiveawayDetailsSchema,
  managedGiveawayParticipantStateSchema,
  managedGiveawayPublicSchema,
  resolveRequiredSubscriptionChannelRequestSchema,
  resolveRequiredSubscriptionChannelResponseSchema,
  type ManagedGiveawayDetails,
  type ManagedGiveawayParticipantState,
  type ManagedGiveawayPublic,
  type ManagedGiveawaySummary,
} from '@maxim/contracts';
import { ApiRequestError } from '../api-request-error';
import { PREVIEW_CHANNEL_ID, PREVIEW_CHANNEL_TITLE } from '../design-preview';
import type { PreviewState } from './preview-transport-state';
import {
  PREVIEW_NOT_HANDLED,
  readPreviewClock,
  resolvePreviewEntityRequest,
  type PreviewClock,
  type PreviewRequestHandler,
} from './preview-transport-runtime';
import { addDays, addHours, cloneJson, parseJsonBody } from './preview-transport-shared';

export type PreviewGiveawayVariant = 'blocked' | 'joined' | 'winner' | 'completed';
export type PreviewGiveawayParticipantVariant =
  | PreviewGiveawayVariant
  | 'blocked-entered'
  | 'winner-claimed';

export const PREVIEW_PUBLIC_GIVEAWAY_ID = 'preview-giveaway';
export const PREVIEW_GIVEAWAY_RUNTIME_STATE_KEY = 'maxim.preview.giveaway.runtime';

function createBroadcastHandoffResponse() {
  return { botUrl: 'https://max.ru/maxim-bot' };
}

function previewGiveawayDetails(
  state: PreviewState,
  details: ManagedGiveawayDetails,
): ManagedGiveawayDetails {
  const channels = new Map(state.channels.map((channel) => [channel.id, channel]));
  const saved = new Map(details.requiredChannels?.map((channel) => [channel.id, channel]));
  return cloneJson({
    ...details,
    requiredChannels: details.requiredChannelIds.map((id) => {
      const channel = channels.get(id) ?? saved.get(id);
      return { id, title: channel?.title || 'Канал из условий', link: channel?.link ?? null };
    }),
  });
}

function assertPreviewDraftRevision(
  details: ManagedGiveawayDetails,
  payload: Record<string, unknown> | null,
) {
  if (
    details.status !== 'DRAFT' ||
    !details.draftRevision ||
    payload?.expectedRevision !== details.draftRevision
  ) {
    throw new ApiRequestError(409, '', 'Черновик изменился. Проверьте сохранённую версию.');
  }
}

export function buildGiveawaySummary(details: ManagedGiveawayDetails): ManagedGiveawaySummary {
  return {
    id: details.id,
    title: details.title,
    status: details.status,
    hasImage: details.hasImage,
    entriesCount: details.entriesCount,
    verifiedEntriesCount: details.verifiedEntriesCount,
    pendingEntriesCount: details.pendingEntriesCount,
    winnersCount: details.winnersCount,
    startsAt: details.startsAt,
    endsAt: details.endsAt,
    publishedAt: details.publishedAt,
    completedAt: details.completedAt,
    publicationUrl: details.publicationUrl,
    resultsUrl: details.resultsUrl,
    createdAt: details.createdAt,
    updatedAt: details.updatedAt,
  };
}

export function readPreviewGiveawayVariant(): PreviewGiveawayVariant {
  const params = new URLSearchParams(window.location.search);
  const value = params.get('giveaway_state');

  if (value === 'joined' || value === 'winner' || value === 'completed') {
    return value;
  }

  return 'blocked';
}

export function readPreviewGiveawayEnterResult(): PreviewGiveawayParticipantVariant | null {
  const params = new URLSearchParams(window.location.search);
  const value = params.get('giveaway_enter_result');
  if (
    value === 'blocked-entered' ||
    value === 'joined' ||
    value === 'winner' ||
    value === 'completed' ||
    value === 'winner-claimed'
  ) {
    return value;
  }

  return null;
}

export function buildPreviewGiveawayRuntimeStateKey(): string {
  const queryVariant = readPreviewGiveawayVariant();
  const enterResult = readPreviewGiveawayEnterResult() ?? 'default';
  return `${PREVIEW_GIVEAWAY_RUNTIME_STATE_KEY}:${queryVariant}:${enterResult}`;
}

export function readPreviewGiveawayParticipantVariant(): PreviewGiveawayParticipantVariant {
  const queryVariant = readPreviewGiveawayVariant();
  if (typeof window === 'undefined') {
    return queryVariant;
  }

  const override = window.sessionStorage.getItem(buildPreviewGiveawayRuntimeStateKey());
  if (
    override === 'blocked' ||
    override === 'joined' ||
    override === 'winner' ||
    override === 'completed' ||
    override === 'blocked-entered' ||
    override === 'winner-claimed'
  ) {
    return override;
  }

  return queryVariant;
}

export function writePreviewGiveawayParticipantVariant(
  variant: PreviewGiveawayParticipantVariant,
): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.sessionStorage.setItem(buildPreviewGiveawayRuntimeStateKey(), variant);
}

export function buildPreviewPublicGiveaway(
  state: PreviewState,
  giveawayId: string,
  variant: PreviewGiveawayVariant,
): ManagedGiveawayPublic {
  const now = readPreviewClock(state.clock);
  const completed = variant === 'completed' || variant === 'winner';
  const sourceChannel = state.channels.find((item) => item.id === PREVIEW_CHANNEL_ID);
  const extraChannel = state.channels.find((item) => item.id === 'preview-channel-2');
  const baitPrizes = Array.from({ length: 10 }, (_, index) => ({
    id: `public-prize-${index + 1}`,
    position: index + 1,
    title: `Прикормка ${index + 1}`,
    displayTitle: 'Прикормка',
  }));

  return managedGiveawayPublicSchema.parse({
    id: giveawayId,
    serverTime: now.toISOString(),
    sourceChatId: PREVIEW_CHANNEL_ID,
    sourceTitle: sourceChannel?.title ?? PREVIEW_CHANNEL_TITLE,
    sourceLink: sourceChannel?.link ?? null,
    sourceAvatarUrl: sourceChannel?.avatarUrl ?? null,
    entityType: 'channel',
    title: variant === 'completed' ? 'Итоги розыгрыша прикормок' : 'Прикормка',
    description:
      'Подпишитесь на канал, отметьте участие и дождитесь итогов. Победителей определим автоматически, а подтверждение приза пройдёт прямо внутри MAX.',
    status: completed ? 'COMPLETED' : 'ACTIVE',
    imageEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    startsAt: addHours(now, -20).toISOString(),
    endsAt: completed ? addHours(now, -2).toISOString() : addHours(now, 28).toISOString(),
    claimHours: 48,
    requiredChannelIds: extraChannel ? [extraChannel.id] : [],
    requiredChannels: extraChannel
      ? [
          {
            id: extraChannel.id,
            title: extraChannel.title,
            link: extraChannel.link ?? null,
          },
        ]
      : [],
    entriesCount: variant === 'completed' ? 912 : 684,
    winnersCount: 10,
    publishedAt: addHours(now, -19.5).toISOString(),
    completedAt: completed ? addHours(now, -1.5).toISOString() : null,
    publicationUrl: 'https://max.ru/giveaway/public-preview',
    resultsUrl: variant === 'completed' ? 'https://max.ru/giveaway/public-preview/results' : null,
    prizes: baitPrizes,
    winners: completed
      ? baitPrizes.map((prize, index) => ({
          prizePosition: prize.position,
          prizeTitle: prize.title,
          prizeDisplayTitle: prize.displayTitle,
          displayName:
            [
              'Марина Орлова',
              'Дмитрий Ковалёв',
              'Анна Соколова',
              'Илья Романов',
              'Елена Миронова',
              'Павел Андреев',
              'Ольга Белова',
              'Артём Волков',
              'Наталья Ким',
              'Сергей Морозов',
            ][index] ?? 'Победитель',
          status: index % 3 === 0 ? 'CLAIMED' : 'DELIVERED',
        }))
      : [],
  });
}

export function buildPreviewGiveawayParticipantState(
  variant: PreviewGiveawayParticipantVariant,
  clock: PreviewClock,
): ManagedGiveawayParticipantState {
  const now = readPreviewClock(clock);

  if (variant === 'winner' || variant === 'winner-claimed') {
    const isClaimed = variant === 'winner-claimed';
    const claimDeadlineAt = addHours(now, 36).toISOString();
    return managedGiveawayParticipantStateSchema.parse({
      joined: true,
      entryId: 'preview-entry-winner',
      eligibilityState: 'VERIFIED',
      eligibilityReason: null,
      missingChannelIds: [],
      joinedAt: addHours(now, -12).toISOString(),
      isWinner: true,
      winnerId: 'preview-winner-1',
      winnerStatus: isClaimed ? 'CLAIMED' : 'SELECTED',
      claimDeadlineAt: isClaimed ? null : claimDeadlineAt,
      prizePosition: 1,
      prizeTitle: 'Прикормка 1',
      prizeDisplayTitle: 'Прикормка',
      canClaim: !isClaimed,
      claimBotUrl: isClaimed ? null : 'https://max.ru/777000_bot?start=preview-claim',
    });
  }

  if (variant === 'joined') {
    return managedGiveawayParticipantStateSchema.parse({
      joined: true,
      entryId: 'preview-entry-joined',
      eligibilityState: 'VERIFIED',
      eligibilityReason: null,
      missingChannelIds: [],
      joinedAt: addHours(now, -4).toISOString(),
      isWinner: false,
      winnerId: null,
      winnerStatus: null,
      claimDeadlineAt: null,
      prizePosition: null,
      prizeTitle: null,
      prizeDisplayTitle: null,
      canClaim: false,
      claimBotUrl: null,
    });
  }

  if (variant === 'completed') {
    return managedGiveawayParticipantStateSchema.parse({
      joined: true,
      entryId: 'preview-entry-completed',
      eligibilityState: 'VERIFIED',
      eligibilityReason: null,
      missingChannelIds: [],
      joinedAt: addHours(now, -18).toISOString(),
      isWinner: false,
      winnerId: null,
      winnerStatus: null,
      claimDeadlineAt: null,
      prizePosition: null,
      prizeTitle: null,
      prizeDisplayTitle: null,
      canClaim: false,
      claimBotUrl: null,
    });
  }

  if (variant === 'blocked-entered') {
    return managedGiveawayParticipantStateSchema.parse({
      joined: true,
      entryId: 'preview-entry-blocked',
      eligibilityState: 'REJECTED',
      eligibilityReason: 'Подписка на обязательный чат/канал не подтверждена.',
      missingChannelIds: ['preview-channel-2'],
      joinedAt: addHours(now, -0.2).toISOString(),
      isWinner: false,
      winnerId: null,
      winnerStatus: null,
      claimDeadlineAt: null,
      prizePosition: null,
      prizeTitle: null,
      prizeDisplayTitle: null,
      canClaim: false,
      claimBotUrl: null,
    });
  }

  return managedGiveawayParticipantStateSchema.parse({
    joined: false,
    entryId: null,
    eligibilityState: null,
    eligibilityReason: null,
    missingChannelIds: [],
    joinedAt: null,
    isWinner: false,
    winnerId: null,
    winnerStatus: null,
    claimDeadlineAt: null,
    prizePosition: null,
    prizeTitle: null,
    prizeDisplayTitle: null,
    canClaim: false,
    claimBotUrl: null,
  });
}

export function findGiveaway(
  giveaways: ManagedGiveawayDetails[],
  giveawayId: string,
): ManagedGiveawayDetails | null {
  return giveaways.find((item) => item.id === giveawayId) ?? null;
}

export function upsertGiveaway(
  giveaways: ManagedGiveawayDetails[],
  giveaway: ManagedGiveawayDetails,
): ManagedGiveawayDetails[] {
  const index = giveaways.findIndex((item) => item.id === giveaway.id);
  if (index === -1) {
    return [giveaway, ...giveaways];
  }

  const next = giveaways.slice();
  next[index] = giveaway;
  return next;
}

export function createDraftGiveaway(
  entityType: 'chat' | 'channel',
  entityId: string,
  clock: PreviewClock,
): ManagedGiveawayDetails {
  const now = readPreviewClock(clock);

  return managedGiveawayDetailsSchema.parse({
    id: `giveaway-${entityType}-${now.getTime()}`,
    draftRevision: 1,
    title: entityType === 'chat' ? 'Новый розыгрыш в чате' : 'Новый розыгрыш в канале',
    status: 'DRAFT',
    hasImage: false,
    entriesCount: 0,
    verifiedEntriesCount: 0,
    pendingEntriesCount: 0,
    winnersCount: 1,
    startsAt: null,
    endsAt: addDays(now, 2).toISOString(),
    publishedAt: null,
    completedAt: null,
    publicationUrl: null,
    resultsUrl: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    sourceChatId: entityId,
    entityType,
    description: '',
    imageEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    claimHours: 24,
    requiredChannelIds: entityType === 'chat' ? [PREVIEW_CHANNEL_ID] : [entityId],
    publicationMessageId: null,
    resultsMessageId: null,
    prizes: [
      {
        id: `prize-${now.getTime()}`,
        position: 1,
        title: 'Приз 1',
        displayTitle: 'Приз 1',
      },
    ],
    winners: [],
  });
}

export function normalizePreviewGiveawayPrizes(value: unknown): ManagedGiveawayDetails['prizes'] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item, index) => {
    const prize = item as {
      id?: unknown;
      position?: unknown;
      title?: unknown;
      displayTitle?: unknown;
    };
    const position = typeof prize.position === 'number' ? prize.position : index + 1;
    const title =
      typeof prize.title === 'string' && prize.title.trim()
        ? prize.title.trim()
        : `Приз ${position}`;
    const displayTitle =
      typeof prize.displayTitle === 'string' && prize.displayTitle.trim()
        ? prize.displayTitle.trim()
        : title;

    return {
      id: typeof prize.id === 'string' && prize.id.trim() ? prize.id : `prize-${position}`,
      position,
      title,
      displayTitle,
    };
  });
}

export function handleChatGiveawayPreviewRequest(
  state: PreviewState,
  chatId: string,
  tail: string[],
  method: string,
  init: RequestInit,
): unknown | typeof PREVIEW_NOT_HANDLED {
  if (tail[0] === 'giveaways' && tail.length === 1) {
    if (method === 'GET') {
      return cloneJson(state.chatGiveaways.map(buildGiveawaySummary));
    }

    if (method === 'POST') {
      const payload = parseJsonBody(init) as Record<string, unknown> | null;
      const draft = createDraftGiveaway('chat', chatId, state.clock);
      const created = managedGiveawayDetailsSchema.parse({
        ...draft,
        ...(payload ?? {}),
        prizes: normalizePreviewGiveawayPrizes((payload ?? draft).prizes),
        sourceChatId: chatId,
        updatedAt: readPreviewClock(state.clock).toISOString(),
      });
      state.chatGiveaways = upsertGiveaway(state.chatGiveaways, created);
      return cloneJson(created);
    }
  }

  if (
    tail[0] === 'giveaways' &&
    tail[1] === 'required-channels' &&
    tail[2] === 'resolve' &&
    method === 'POST'
  ) {
    const payload = resolveRequiredSubscriptionChannelRequestSchema.parse(parseJsonBody(init));
    const normalizedValue = payload.value.trim().toLowerCase();
    const normalizedLink = normalizedValue.startsWith('http')
      ? normalizedValue
      : normalizedValue.startsWith('max.ru/')
        ? `https://${normalizedValue}`
        : normalizedValue;
    const channel = state.channels.find(
      (item) =>
        item.id === payload.value.trim() ||
        item.link?.trim().toLowerCase() === normalizedLink ||
        item.link?.trim().toLowerCase() === payload.value.trim().toLowerCase(),
    );

    if (!channel) {
      throw new Error('Канал по этой ссылке не найден.');
    }

    return resolveRequiredSubscriptionChannelResponseSchema.parse({
      channel: {
        id: channel.id,
        title: channel.title,
        entityType: 'channel',
        link: channel.link ?? null,
        participantsCount: null,
      },
    });
  }

  if (tail[0] === 'giveaways' && tail[1] && tail.length === 2) {
    const details = findGiveaway(state.chatGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    if (method === 'GET') {
      return previewGiveawayDetails(state, details);
    }

    if (method === 'PUT') {
      const payload = parseJsonBody(init) as Record<string, unknown> | null;
      assertPreviewDraftRevision(details, payload);
      const updated = managedGiveawayDetailsSchema.parse({
        ...details,
        ...(payload ?? {}),
        draftRevision: (details.draftRevision ?? 1) + 1,
        prizes: normalizePreviewGiveawayPrizes((payload ?? details).prizes),
        sourceChatId: chatId,
        updatedAt: readPreviewClock(state.clock).toISOString(),
      });
      state.chatGiveaways = upsertGiveaway(state.chatGiveaways, updated);
      return cloneJson(updated);
    }

    if (method === 'DELETE') {
      state.chatGiveaways = state.chatGiveaways.filter((item) => item.id !== details.id);
      return null;
    }
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'publish' && method === 'POST') {
    const details = findGiveaway(state.chatGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    assertPreviewDraftRevision(details, parseJsonBody(init) as Record<string, unknown> | null);
    const published = managedGiveawayDetailsSchema.parse({
      ...details,
      status: details.startsAt ? 'SCHEDULED' : 'ACTIVE',
      publishedAt: readPreviewClock(state.clock).toISOString(),
      publicationMessageId: `giveaway-${readPreviewClock(state.clock).getTime()}`,
      publicationUrl: 'https://max.ru/giveaway/published-preview',
      updatedAt: readPreviewClock(state.clock).toISOString(),
    });
    state.chatGiveaways = upsertGiveaway(state.chatGiveaways, published);
    return cloneJson(published);
  }

  if (
    tail[0] === 'giveaways' &&
    tail[1] &&
    tail[2] === 'refresh-publication' &&
    method === 'POST'
  ) {
    const details = findGiveaway(state.chatGiveaways, tail[1]);
    if (!details) throw new Error('Розыгрыш не найден.');
    return cloneJson(details);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'close' && method === 'POST') {
    const details = findGiveaway(state.chatGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    const completed = managedGiveawayDetailsSchema.parse({
      ...details,
      status: 'COMPLETED',
      completedAt: readPreviewClock(state.clock).toISOString(),
      winnersCount: details.prizes.length,
      resultsMessageId: `giveaway-results-${readPreviewClock(state.clock).getTime()}`,
      resultsUrl: 'https://max.ru/giveaway/results-preview',
      updatedAt: readPreviewClock(state.clock).toISOString(),
    });
    state.chatGiveaways = upsertGiveaway(state.chatGiveaways, completed);
    return cloneJson(completed);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'cancel' && method === 'POST') {
    const details = findGiveaway(state.chatGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    const canceled = managedGiveawayDetailsSchema.parse({
      ...details,
      status: 'CANCELED',
      updatedAt: readPreviewClock(state.clock).toISOString(),
    });
    state.chatGiveaways = upsertGiveaway(state.chatGiveaways, canceled);
    return cloneJson(canceled);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'reroll' && method === 'POST') {
    const details = findGiveaway(state.chatGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }
    return cloneJson(details);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'deliver' && method === 'POST') {
    const details = findGiveaway(state.chatGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }
    return cloneJson(details);
  }

  if (tail[0] === 'giveaway' && tail[1] === 'handoff' && method === 'POST') {
    return createBroadcastHandoffResponse();
  }

  return PREVIEW_NOT_HANDLED;
}

export function handleChannelGiveawayPreviewRequest(
  state: PreviewState,
  channelId: string,
  tail: string[],
  method: string,
  init: RequestInit,
): unknown | typeof PREVIEW_NOT_HANDLED {
  if (tail[0] === 'giveaways' && tail.length === 1) {
    if (method === 'GET') {
      return cloneJson(state.channelGiveaways.map(buildGiveawaySummary));
    }

    if (method === 'POST') {
      const payload = parseJsonBody(init) as Record<string, unknown> | null;
      const draft = createDraftGiveaway('channel', channelId, state.clock);
      const created = managedGiveawayDetailsSchema.parse({
        ...draft,
        ...(payload ?? {}),
        prizes: normalizePreviewGiveawayPrizes((payload ?? draft).prizes),
        sourceChatId: channelId,
        entityType: 'channel',
        updatedAt: readPreviewClock(state.clock).toISOString(),
      });
      state.channelGiveaways = upsertGiveaway(state.channelGiveaways, created);
      return cloneJson(created);
    }
  }

  if (
    tail[0] === 'giveaways' &&
    tail[1] === 'required-channels' &&
    tail[2] === 'resolve' &&
    method === 'POST'
  ) {
    const payload = resolveRequiredSubscriptionChannelRequestSchema.parse(parseJsonBody(init));
    const normalizedValue = payload.value.trim().toLowerCase();
    const normalizedLink = normalizedValue.startsWith('http')
      ? normalizedValue
      : normalizedValue.startsWith('max.ru/')
        ? `https://${normalizedValue}`
        : normalizedValue;
    const channel = state.channels.find(
      (item) =>
        item.id === payload.value.trim() ||
        item.link?.trim().toLowerCase() === normalizedLink ||
        item.link?.trim().toLowerCase() === payload.value.trim().toLowerCase(),
    );

    if (!channel) {
      throw new Error('Канал по этой ссылке не найден.');
    }

    return resolveRequiredSubscriptionChannelResponseSchema.parse({
      channel: {
        id: channel.id,
        title: channel.title,
        entityType: 'channel',
        link: channel.link ?? null,
        participantsCount: null,
      },
    });
  }

  if (tail[0] === 'giveaways' && tail[1] && tail.length === 2) {
    const details = findGiveaway(state.channelGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    if (method === 'GET') {
      return previewGiveawayDetails(state, details);
    }

    if (method === 'PUT') {
      const payload = parseJsonBody(init) as Record<string, unknown> | null;
      assertPreviewDraftRevision(details, payload);
      const updated = managedGiveawayDetailsSchema.parse({
        ...details,
        ...(payload ?? {}),
        draftRevision: (details.draftRevision ?? 1) + 1,
        prizes: normalizePreviewGiveawayPrizes((payload ?? details).prizes),
        sourceChatId: channelId,
        entityType: 'channel',
        updatedAt: readPreviewClock(state.clock).toISOString(),
      });
      state.channelGiveaways = upsertGiveaway(state.channelGiveaways, updated);
      return cloneJson(updated);
    }

    if (method === 'DELETE') {
      state.channelGiveaways = state.channelGiveaways.filter((item) => item.id !== details.id);
      return null;
    }
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'publish' && method === 'POST') {
    const details = findGiveaway(state.channelGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    assertPreviewDraftRevision(details, parseJsonBody(init) as Record<string, unknown> | null);
    const published = managedGiveawayDetailsSchema.parse({
      ...details,
      status: details.startsAt ? 'SCHEDULED' : 'ACTIVE',
      publishedAt: readPreviewClock(state.clock).toISOString(),
      publicationMessageId: `giveaway-channel-${readPreviewClock(state.clock).getTime()}`,
      publicationUrl: 'https://max.ru/giveaway/channel-preview',
      updatedAt: readPreviewClock(state.clock).toISOString(),
    });
    state.channelGiveaways = upsertGiveaway(state.channelGiveaways, published);
    return cloneJson(published);
  }

  if (
    tail[0] === 'giveaways' &&
    tail[1] &&
    tail[2] === 'refresh-publication' &&
    method === 'POST'
  ) {
    const details = findGiveaway(state.channelGiveaways, tail[1]);
    if (!details) throw new Error('Розыгрыш не найден.');
    return cloneJson(details);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'close' && method === 'POST') {
    const details = findGiveaway(state.channelGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    const completed = managedGiveawayDetailsSchema.parse({
      ...details,
      status: 'COMPLETED',
      completedAt: readPreviewClock(state.clock).toISOString(),
      winnersCount: details.prizes.length,
      resultsMessageId: `giveaway-channel-results-${readPreviewClock(state.clock).getTime()}`,
      resultsUrl: 'https://max.ru/giveaway/channel-results-preview',
      updatedAt: readPreviewClock(state.clock).toISOString(),
    });
    state.channelGiveaways = upsertGiveaway(state.channelGiveaways, completed);
    return cloneJson(completed);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'cancel' && method === 'POST') {
    const details = findGiveaway(state.channelGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    const canceled = managedGiveawayDetailsSchema.parse({
      ...details,
      status: 'CANCELED',
      updatedAt: readPreviewClock(state.clock).toISOString(),
    });
    state.channelGiveaways = upsertGiveaway(state.channelGiveaways, canceled);
    return cloneJson(canceled);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'reroll' && method === 'POST') {
    const details = findGiveaway(state.channelGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }
    return cloneJson(details);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'deliver' && method === 'POST') {
    const details = findGiveaway(state.channelGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }
    return cloneJson(details);
  }

  if (tail[0] === 'giveaway' && tail[1] === 'handoff' && method === 'POST') {
    return createBroadcastHandoffResponse();
  }

  return PREVIEW_NOT_HANDLED;
}

export const handleGiveawaysPreviewRequest: PreviewRequestHandler = (context) => {
  const { segments, state, method } = context;
  if (segments[0] === 'giveaways' && segments[1]) {
    const giveawayId = decodeURIComponent(segments[1]);
    if (giveawayId !== PREVIEW_PUBLIC_GIVEAWAY_ID) {
      throw new Error(`Preview public giveaway not found: ${giveawayId}`);
    }
    const variant = readPreviewGiveawayVariant();
    if (segments.length === 2 && method === 'GET') {
      return managedGiveawayPublicSchema.parse(
        buildPreviewPublicGiveaway(state, giveawayId, variant),
      );
    }
    if (segments[2] === 'me' && method === 'GET') {
      return managedGiveawayParticipantStateSchema.parse(
        buildPreviewGiveawayParticipantState(readPreviewGiveawayParticipantVariant(), state.clock),
      );
    }
    if (segments[2] === 'enter' && method === 'POST') {
      const nextVariant =
        readPreviewGiveawayEnterResult() ?? (variant === 'blocked' ? 'blocked-entered' : variant);
      writePreviewGiveawayParticipantVariant(nextVariant);
      return managedGiveawayParticipantStateSchema.parse(
        buildPreviewGiveawayParticipantState(nextVariant, state.clock),
      );
    }
    if (segments[2] === 'claim' && method === 'POST') {
      writePreviewGiveawayParticipantVariant('winner-claimed');
      const now = readPreviewClock(state.clock);
      return {
        ok: true,
        winner: {
          id: 'preview-winner-1',
          prizeId: 'public-prize-1',
          prizePosition: 1,
          prizeTitle: 'Прикормка 1',
          prizeDisplayTitle: 'Прикормка',
          entryId: 'preview-entry-winner',
          userId: 'preview-user',
          displayName: 'Участник',
          status: 'CLAIMED',
          selectedAt: addHours(now, -2).toISOString(),
          claimDeadlineAt: addHours(now, 36).toISOString(),
          claimedAt: now.toISOString(),
          deliveredAt: null,
          expiredAt: null,
          rerolledAt: null,
        },
      };
    }
  }

  const entity = resolvePreviewEntityRequest(context);
  if (!entity || (entity.tail[0] !== 'giveaways' && entity.tail[0] !== 'giveaway')) {
    return PREVIEW_NOT_HANDLED;
  }
  return entity.entityType === 'chat'
    ? handleChatGiveawayPreviewRequest(state, entity.entityId, entity.tail, method, context.init)
    : handleChannelGiveawayPreviewRequest(
        state,
        entity.entityId,
        entity.tail,
        method,
        context.init,
      );
};
