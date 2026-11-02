import {
  chatParticipantImmunitySchema,
  chatParticipantImmunityUpdateRequestSchema,
  chatParticipantImmunityUpdateResultSchema,
  chatParticipantsPageSchema,
  chatUnavailableParticipantsCleanupRequestSchema,
  chatUnavailableParticipantsCleanupResultSchema,
  globalSpammerReviewQueueSchema,
  globalSpammerReviewRequestSchema,
  logsDashboardResponseSchema,
  manualModerationActionRequestSchema,
  membershipActivityPageSchema,
  moderationFeedPageSchema,
  type ChatParticipantImmunityUpdateRequest,
  type ChatParticipantItem,
  type ChatParticipantsPage,
  type ChatParticipantsQuery,
  type ChatUnavailableParticipantsCleanupRequest,
  type GlobalSpammerReviewRequest,
  type LogsDashboardRange,
  type LogsDashboardResponse,
  type MembershipActivityFilter,
  type MembershipActivityItem,
  type MembershipActivityPage,
  type MembershipActivityRange,
  type ModerationFeedFilter,
  type ModerationFeedPage,
} from '@maxim/contracts';
import {
  channelStatsResponseSchema,
  type ChannelStatsBucket,
  type ChannelStatsMode,
  type ChannelStatsRange,
  type ChannelStatsResponse,
} from '@maxim/contracts/channel-stats';
import {
  resolveChannelAvatarUrl,
  resolveChannelTitle,
  resolveChatAvatarUrl,
  resolveChatTitle,
} from './preview-transport-dialog';
import {
  applyPreviewManualModeration,
  buildPreviewSpammerDiagnostics,
  buildPreviewSpammerReviewMetrics,
  createModerationResult,
  createPreviewSpammerReviewResult,
  buildPreviewParticipantDetails,
} from './preview-transport-events-fixtures';
import type { PreviewState } from './preview-transport-state';
import { buildPreviewSanctionsPage, createPreviewOlderSanctions } from './preview-chat-sanctions';
import {
  PREVIEW_NOT_HANDLED,
  readPreviewClock,
  resolvePreviewEntityRequest,
  type PreviewClock,
  type PreviewRequestHandler,
} from './preview-transport-runtime';
import {
  addDays,
  addHours,
  buildPreviewAvatarDataUrl,
  buildPreviewProfileHandoffUrl,
  buildPreviewProfileUrl,
  cloneJson,
  parseJsonBody,
} from './preview-transport-shared';

export function formatMoscowDateKey(value: Date): string {
  return new Date(value.getTime() + 3 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

export function floorPreviewMoscowDay(value: Date): Date {
  const moscowDate = new Date(value.getTime() + 3 * 60 * 60 * 1_000);
  moscowDate.setUTCHours(0, 0, 0, 0);
  return new Date(moscowDate.getTime() - 3 * 60 * 60 * 1_000);
}

export function floorPreviewStatsBucket(value: Date, bucket: ChannelStatsBucket): Date {
  if (bucket === 'day') {
    return floorPreviewMoscowDay(value);
  }

  const result = new Date(value);
  result.setUTCMinutes(0, 0, 0);
  return result;
}

export function shiftPreviewStatsBucket(
  value: Date,
  bucket: ChannelStatsBucket,
  amount: number,
): Date {
  const result = new Date(value);
  if (bucket === 'hour') {
    result.setUTCHours(result.getUTCHours() + amount);
    return result;
  }

  result.setUTCDate(result.getUTCDate() + amount);
  return result;
}

export function buildPreviewStatsBucketStarts(
  from: Date,
  to: Date,
  bucket: ChannelStatsBucket,
): Date[] {
  const starts: Date[] = [];
  let cursor = floorPreviewStatsBucket(from, bucket);
  const end = floorPreviewStatsBucket(to, bucket);

  while (cursor.getTime() <= end.getTime()) {
    starts.push(cursor);
    cursor = shiftPreviewStatsBucket(cursor, bucket, 1);
  }

  return starts;
}

export function createPreviewImmunity(
  durationHours: number,
  dailyViolationLimit: number,
  clock: PreviewClock,
  used = 0,
) {
  return chatParticipantImmunitySchema.parse({
    mode: 'limited',
    expiresAt: addHours(readPreviewClock(clock), durationHours).toISOString(),
    dailyViolationLimit,
    usedViolatingMessagesToday: used,
    remainingViolatingMessagesToday: Math.max(0, dailyViolationLimit - used),
  });
}

export function createPreviewAlwaysImmunity() {
  return chatParticipantImmunitySchema.parse({
    mode: 'always',
    expiresAt: null,
    dailyViolationLimit: null,
    usedViolatingMessagesToday: 0,
    remainingViolatingMessagesToday: null,
  });
}

export function resolveRangeWindow(range: MembershipActivityRange, now: Date) {
  const to = new Date(now);
  const from = new Date(now);

  if (range === '24h') {
    from.setHours(from.getHours() - 24);
  } else if (range === '7d') {
    from.setDate(from.getDate() - 7);
  } else {
    from.setDate(from.getDate() - 30);
  }

  return { from, to };
}

export function isWithinRange(
  createdAt: string,
  range: MembershipActivityRange,
  now: Date,
): boolean {
  const timestamp = new Date(createdAt).getTime();
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  const { from, to } = resolveRangeWindow(range, now);
  return timestamp >= from.getTime() && timestamp <= to.getTime();
}

export function filterActivityItems(
  items: MembershipActivityItem[],
  range: MembershipActivityRange,
  filter: MembershipActivityFilter,
  now: Date,
): MembershipActivityItem[] {
  return items.filter((item) => {
    if (!isWithinRange(item.createdAt, range, now)) {
      return false;
    }

    if (filter !== 'all' && item.type !== filter) {
      return false;
    }

    return true;
  });
}

export function matchesModerationFeedFilter(
  item: LogsDashboardResponse['violations'][number],
  filter: ModerationFeedFilter,
): boolean {
  if (filter === 'ALL') {
    return true;
  }

  if (filter === 'UNBAN') {
    return item.ruleCode === 'MANUAL_UNBAN';
  }

  return item.action === filter;
}

export function buildModerationFeedPage(
  items: LogsDashboardResponse['violations'],
  {
    range,
    filter = 'ALL',
    limit = 50,
    cursor,
  }: {
    range: LogsDashboardRange;
    filter?: ModerationFeedFilter;
    limit?: number;
    cursor?: string | null;
  },
  now: Date,
): ModerationFeedPage {
  const filtered = items.filter(
    (item) =>
      isWithinRange(item.createdAt, range, now) && matchesModerationFeedFilter(item, filter),
  );
  const offset = cursor ? Number.parseInt(cursor, 10) : 0;
  const safeOffset = Number.isFinite(offset) && offset > 0 ? offset : 0;
  const pageItems = filtered.slice(safeOffset, safeOffset + limit);
  const nextOffset = safeOffset + pageItems.length;

  return moderationFeedPageSchema.parse({
    items: pageItems,
    hasMore: nextOffset < filtered.length,
    nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
  });
}

export function buildActivityPage(
  items: MembershipActivityItem[],
  {
    range,
    filter = 'all',
    limit = 50,
    cursor,
  }: {
    range: MembershipActivityRange;
    filter?: MembershipActivityFilter;
    limit?: number;
    cursor?: string | null;
  },
  now: Date,
): MembershipActivityPage {
  const filtered = filterActivityItems(items, range, filter, now);
  const offset = cursor ? Number.parseInt(cursor, 10) : 0;
  const safeOffset = Number.isFinite(offset) && offset > 0 ? offset : 0;
  const pageItems = filtered.slice(safeOffset, safeOffset + limit);
  const nextOffset = safeOffset + pageItems.length;

  return membershipActivityPageSchema.parse({
    items: pageItems,
    hasMore: nextOffset < filtered.length,
    nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
  });
}

export function isViolationCounterEvent(
  item: LogsDashboardResponse['violations'][number],
): boolean {
  return (
    item.action === 'WARN' ||
    item.action === 'DELETE_MESSAGE' ||
    item.action === 'MUTE' ||
    item.action === 'KICK' ||
    item.action === 'BAN'
  );
}

export function buildParticipantsPage(
  items: ChatParticipantItem[],
  {
    range = '7d',
    limit = 100,
    cursor,
    search,
    roleFilter = 'all',
    activityFilter = 'all',
  }: {
    range?: LogsDashboardRange;
    limit?: number;
    cursor?: string | null;
    search?: string | null;
    roleFilter?: ChatParticipantsQuery['roleFilter'];
    activityFilter?: ChatParticipantsQuery['activityFilter'];
  },
  totalCount: number,
  violations: LogsDashboardResponse['violations'],
  now: Date,
): ChatParticipantsPage {
  const offset = cursor ? Number.parseInt(cursor, 10) : 0;
  const safeOffset = Number.isFinite(offset) && offset > 0 ? offset : 0;
  const normalizedSearch = normalizeParticipantSearchText(search ?? '');
  const filteredItems = items.filter(
    (item) =>
      (!normalizedSearch || participantMatchesSearch(item, normalizedSearch)) &&
      participantMatchesRoleFilter(item, roleFilter) &&
      (activityFilter === 'all' ||
        ((!item.isBot || roleFilter === 'bots') &&
          (activityFilter === 'unknown'
            ? !item.lastMaxActivityAt
            : Boolean(
                item.lastMaxActivityAt &&
                now.getTime() - Date.parse(item.lastMaxActivityAt) >=
                  Number(activityFilter.slice(0, -1)) * 86_400_000,
              )))),
  );
  const violationCountByUserId = new Map<string, number>();

  for (const violation of violations) {
    if (!isWithinRange(violation.createdAt, range, now) || !isViolationCounterEvent(violation)) {
      continue;
    }

    violationCountByUserId.set(
      violation.userId,
      (violationCountByUserId.get(violation.userId) ?? 0) + 1,
    );
  }

  const pageItems = filteredItems.slice(safeOffset, safeOffset + limit).map((item) => ({
    ...item,
    violationCount: violationCountByUserId.get(item.userId) ?? 0,
  }));
  const nextOffset = safeOffset + pageItems.length;

  return chatParticipantsPageSchema.parse({
    items: pageItems,
    totalCount,
    hasMore: nextOffset < filteredItems.length,
    nextCursor: nextOffset < filteredItems.length ? String(nextOffset) : null,
  });
}

export function participantMatchesRoleFilter(
  item: ChatParticipantItem,
  roleFilter: ChatParticipantsQuery['roleFilter'],
): boolean {
  if (roleFilter === 'all') {
    return true;
  }
  if (roleFilter === 'bots') {
    return item.isBot;
  }
  if (item.isBot) {
    return false;
  }
  if (roleFilter === 'admins') {
    return item.role === 'owner' || item.role === 'admin';
  }
  return item.role === 'member';
}

export function normalizeParticipantSearchText(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('ru-RU');
  const withoutMentionPrefix = normalized.replace(/^@+/u, '');
  return withoutMentionPrefix || normalized;
}

export function participantMatchesSearch(item: ChatParticipantItem, search: string): boolean {
  const username = item.username?.replace(/^@+/u, '').trim() ?? '';
  const candidates = [item.userDisplayName, username, username ? `@${username}` : '', item.userId];

  return candidates.some((candidate) => normalizeParticipantSearchText(candidate).includes(search));
}

export function createActivityItems(
  prefix: string,
  names: string[],
  now: Date,
  offsetsHours: number[],
): MembershipActivityItem[] {
  const avatarPalette = [
    ['#4d94ff', '#2b64dd'],
    ['#3cc58b', '#0f9f70'],
    ['#f1a44b', '#ea7b4b'],
    ['#7f7dff', '#5350da'],
  ] as const;

  return offsetsHours
    .map((offsetHours, index) => {
      const displayName = names[index % names.length] ?? `Участник ${index + 1}`;
      const [startColor, endColor] = avatarPalette[index % avatarPalette.length] ?? [
        '#4d94ff',
        '#2b64dd',
      ];

      return {
        id: `${prefix}-${index + 1}`,
        type: (index % 3 === 1 ? 'left' : 'joined') as MembershipActivityItem['type'],
        userId: `${prefix}-user-${index + 1}`,
        userDisplayName: displayName,
        avatarUrl: buildPreviewAvatarDataUrl(displayName, startColor, endColor),
        profileUrl: buildPreviewProfileUrl(`${prefix}-profile-${index + 1}`),
        profileHandoffUrl: buildPreviewProfileHandoffUrl(`${prefix}-${index + 1}`),
        createdAt: addHours(now, -offsetHours).toISOString(),
      };
    })
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export function createParticipantsItems(
  prefix: string,
  count: number,
  clock: PreviewClock,
): ChatParticipantItem[] {
  const avatarPalette = [
    ['#4d94ff', '#2b64dd'],
    ['#3cc58b', '#0f9f70'],
    ['#f1a44b', '#ea7b4b'],
    ['#7f7dff', '#5350da'],
    ['#ff82a8', '#eb577f'],
  ] as const;
  const names = [
    'Александра',
    'Марина Орлова',
    'Павел',
    'Ольга',
    'Наталья',
    'Илья',
    'Екатерина',
    'Артём',
    'Диана',
    'Юрий',
  ];
  const featuredParticipants = [
    null,
    null,
    null,
    null,
    {
      userId: 'preview-spammer-1',
      userDisplayName: 'Сергей Маркет',
      username: 'sergey-market',
    },
    {
      userId: 'preview-spammer-2',
      userDisplayName: 'Мария Ссылкина',
      username: 'maria-links',
    },
    {
      userId: 'preview-user-3',
      userDisplayName: 'Антон',
      username: 'anton-preview',
    },
    {
      userId: 'preview-user-4',
      userDisplayName: 'Инфо Буст',
      username: 'info-boost',
    },
    {
      userId: 'preview-user-5',
      userDisplayName: 'Юлия',
      username: 'yulia-preview',
    },
    {
      userId: 'preview-user-6',
      userDisplayName: 'Олег Повтор',
      username: 'oleg-repeat',
    },
  ] as const;

  return Array.from({ length: count }, (_, index) => {
    const featuredParticipant = featuredParticipants[index] ?? null;
    const displayName =
      featuredParticipant?.userDisplayName ??
      names[index % names.length] ??
      `Участник ${index + 1}`;
    const [startColor, endColor] = avatarPalette[index % avatarPalette.length] ?? [
      '#4d94ff',
      '#2b64dd',
    ];
    const role =
      index === 0 ? 'owner' : index < 4 ? 'admin' : ('member' as ChatParticipantItem['role']);
    const isBot = index === count - 1 || index === count - 2;
    const username = isBot
      ? `helper_${index + 1}_bot`
      : (featuredParticipant?.username ?? `preview_member_${index + 1}`);
    const label = isBot ? (index === count - 1 ? 'Рэкс' : 'Майор Максимова') : displayName;
    const immunity =
      !isBot && index === 4
        ? createPreviewImmunity(72, 5, clock, 1)
        : !isBot && index === 7
          ? createPreviewAlwaysImmunity()
          : null;

    return {
      userId: isBot
        ? `${prefix}-member-${index + 1}_bot`
        : (featuredParticipant?.userId ?? `${prefix}-member-${index + 1}`),
      userDisplayName: label,
      username,
      avatarUrl: buildPreviewAvatarDataUrl(label, startColor, endColor),
      profileUrl: buildPreviewProfileUrl(username),
      profileHandoffUrl: buildPreviewProfileHandoffUrl(`${prefix}-member-${index + 1}`),
      violationCount: 0,
      immunity,
      role: isBot ? 'admin' : role,
      isBot,
      lastMaxActivityAt:
        index % 7 === 6
          ? null
          : addDays(
              readPreviewClock(clock),
              -([0, 3, 8, 16, 38, 72, 100][index % 7] ?? 0),
            ).toISOString(),
      activityCheckedAt: readPreviewClock(clock).toISOString(),
    };
  });
}

export function createChatViolations(now: Date): LogsDashboardResponse['violations'] {
  const base: LogsDashboardResponse['violations'] = [
    {
      id: 'violation-1',
      action: 'MUTE' as const,
      ruleCode: 'COMMERCIAL_AD',
      userId: 'preview-spammer-1',
      userDisplayName: 'Сергей Маркет',
      avatarUrl: buildPreviewAvatarDataUrl('Сергей Маркет', '#4d94ff', '#2b64dd'),
      profileUrl: buildPreviewProfileUrl('sergey-market'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('sergey-market'),
      createdAt: addHours(now, -1.5).toISOString(),
      maskedExcerpt: 'Переходите по ссылке и получайте скидку ***',
      metadata: { muteDurationHours: 24, muteExpiresAt: addHours(now, 22.5).toISOString() },
    },
    {
      id: 'violation-2',
      action: 'DELETE_MESSAGE' as const,
      ruleCode: 'LINK_BLOCKED',
      userId: 'preview-spammer-2',
      userDisplayName: 'Мария Ссылкина',
      avatarUrl: buildPreviewAvatarDataUrl('Мария Ссылкина', '#3cc58b', '#0f9f70'),
      profileUrl: buildPreviewProfileUrl('maria-links'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('maria-links'),
      createdAt: addHours(now, -3.2).toISOString(),
      maskedExcerpt: 'Подписывайтесь на мой канал ***',
      metadata: null,
    },
    {
      id: 'violation-3',
      action: 'WARN' as const,
      ruleCode: 'PROFANITY',
      userId: 'preview-user-3',
      userDisplayName: 'Антон',
      avatarUrl: buildPreviewAvatarDataUrl('Антон', '#7f7dff', '#5350da'),
      profileUrl: buildPreviewProfileUrl('anton-preview'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('anton-preview'),
      createdAt: addHours(now, -6.8).toISOString(),
      maskedExcerpt: 'Это было очень ***',
      metadata: null,
    },
    {
      id: 'violation-4',
      action: 'BAN' as const,
      ruleCode: 'GLOBAL_CROSS_CHAT_SPAM',
      userId: 'preview-user-4',
      userDisplayName: 'Инфо Буст',
      avatarUrl: buildPreviewAvatarDataUrl('Инфо Буст', '#f1a44b', '#ea7b4b'),
      profileUrl: buildPreviewProfileUrl('info-boost'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('info-boost'),
      createdAt: addHours(now, -14.1).toISOString(),
      maskedExcerpt: 'Повторный оффер с внешней ссылкой ***',
      metadata: null,
    },
    {
      id: 'violation-5',
      action: 'DELETE_MESSAGE' as const,
      ruleCode: 'MESSAGE_TOO_LONG',
      userId: 'preview-user-5',
      userDisplayName: 'Юлия',
      avatarUrl: buildPreviewAvatarDataUrl('Юлия', '#ff82a8', '#eb577f'),
      profileUrl: buildPreviewProfileUrl('yulia-preview'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('yulia-preview'),
      createdAt: addHours(now, -27).toISOString(),
      maskedExcerpt: 'Очень длинное сообщение ***',
      metadata: null,
    },
    {
      id: 'violation-6',
      action: 'MUTE' as const,
      ruleCode: 'DUPLICATE_BAN',
      userId: 'preview-user-6',
      userDisplayName: 'Олег Повтор',
      avatarUrl: buildPreviewAvatarDataUrl('Олег Повтор', '#7db8ff', '#4d89ff'),
      profileUrl: buildPreviewProfileUrl('oleg-repeat'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('oleg-repeat'),
      createdAt: addHours(now, -42).toISOString(),
      maskedExcerpt: 'Одинаковый текст ***',
      metadata: { muteDurationHours: 12, muteExpiresAt: addHours(now, -30).toISOString() },
    },
    {
      id: 'violation-7',
      action: 'DELETE_MESSAGE' as const,
      ruleCode: 'NIGHT_MODE_DELETE',
      userId: 'preview-user-7',
      userDisplayName: 'Ночной гость',
      avatarUrl: buildPreviewAvatarDataUrl('Ночной гость', '#485a7b', '#22344f'),
      profileUrl: buildPreviewProfileUrl('night-guest'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('night-guest'),
      createdAt: addHours(now, -73).toISOString(),
      maskedExcerpt: 'Сообщение ночью ***',
      metadata: null,
    },
    {
      id: 'violation-8',
      action: 'WARN' as const,
      ruleCode: 'THEMATIC_FILTER',
      userId: 'preview-user-8',
      userDisplayName: 'Павел',
      avatarUrl: buildPreviewAvatarDataUrl('Павел', '#5ab7b5', '#1b7f8a'),
      profileUrl: buildPreviewProfileUrl('pavel-preview'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('pavel-preview'),
      createdAt: addHours(now, -110).toISOString(),
      maskedExcerpt: 'Не по теме ***',
      metadata: null,
    },
    {
      id: 'violation-9',
      action: 'NONE' as const,
      ruleCode: 'MANUAL_UNBAN',
      userId: 'preview-user-9',
      userDisplayName: 'Ольга',
      avatarUrl: buildPreviewAvatarDataUrl('Ольга', '#f1a44b', '#ea7b4b'),
      profileUrl: buildPreviewProfileUrl('olga-preview'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('olga-preview'),
      createdAt: addHours(now, -180).toISOString(),
      maskedExcerpt: null,
      metadata: null,
    },
    {
      id: 'violation-10',
      action: 'MUTE' as const,
      ruleCode: 'MANUAL_MUTE',
      userId: 'preview-user-10',
      userDisplayName: 'Андрей',
      avatarUrl: buildPreviewAvatarDataUrl('Андрей', '#4d94ff', '#2b64dd'),
      profileUrl: buildPreviewProfileUrl('andrey-preview'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('andrey-preview'),
      createdAt: addHours(now, -220).toISOString(),
      maskedExcerpt: null,
      metadata: null,
    },
  ];

  base.push(...createPreviewOlderSanctions(now));

  return base.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export function buildLogsDashboard(
  state: PreviewState,
  chatId: string,
  range: LogsDashboardRange,
  options: {
    includeActivityPreview?: boolean;
    includeModerationPreview?: boolean;
  } = {},
): LogsDashboardResponse {
  const now = readPreviewClock(state.clock);
  const violations = state.chatViolations.filter((item) =>
    isWithinRange(item.createdAt, range, now),
  );
  const membershipItems = filterActivityItems(state.chatActivity, range, 'all', now);
  const joinedUsers = membershipItems.filter((item) => item.type === 'joined').length;
  const leftUsers = membershipItems.filter((item) => item.type === 'left').length;
  const summary = violations.reduce(
    (accumulator, item) => {
      if (item.ruleCode === 'MANUAL_UNMUTE') {
        accumulator.unmute += 1;
      } else if (item.ruleCode === 'MANUAL_UNBAN') {
        accumulator.unban += 1;
      } else if (item.action === 'WARN') {
        accumulator.warn += 1;
      } else if (item.action === 'DELETE_MESSAGE') {
        accumulator.deleteMessage += 1;
      } else if (item.action === 'MUTE') {
        accumulator.mute += 1;
      } else if (item.action === 'KICK' || item.action === 'BAN') {
        accumulator.ban += 1;
      }

      accumulator.users.add(item.userId);
      return accumulator;
    },
    {
      warn: 0,
      deleteMessage: 0,
      mute: 0,
      ban: 0,
      unmute: 0,
      unban: 0,
      users: new Set<string>(),
    },
  );
  const { from, to } = resolveRangeWindow(range, now);
  const includeActivityPreview = options.includeActivityPreview !== false;
  const includeModerationPreview = options.includeModerationPreview !== false;
  const moderationFeed = includeModerationPreview
    ? buildModerationFeedPage(
        state.chatViolations,
        {
          range,
          filter: 'ALL',
          limit: 50,
        },
        now,
      )
    : {
        items: [],
        hasMore: false,
        nextCursor: null,
      };
  const activityFeed = includeActivityPreview
    ? buildActivityPage(state.chatActivity, { range, limit: 50 }, now)
    : {
        items: [],
        hasMore: false,
        nextCursor: null,
      };

  return logsDashboardResponseSchema.parse({
    chat: {
      id: chatId,
      title: resolveChatTitle(chatId, state),
      participantsCount: state.chatHeaderParticipantsCount,
      avatarUrl: resolveChatAvatarUrl(chatId, state),
    },
    period: {
      range,
      from: from.toISOString(),
      to: to.toISOString(),
    },
    membership: {
      joinedUsers,
      leftUsers,
      netUsers: joinedUsers - leftUsers,
    },
    violationsSummary: {
      warn: summary.warn,
      deleteMessage: summary.deleteMessage,
      mute: summary.mute,
      ban: summary.ban,
      unmute: summary.unmute,
      unban: summary.unban,
      affectedUsers: summary.users.size,
      total: violations.length,
    },
    violations: moderationFeed.items,
    moderationFeed,
    activityFeed,
  });
}

export function buildChannelStats(
  state: PreviewState,
  channelId: string,
  range: ChannelStatsRange,
  options: Partial<{
    includeActivityPreview: boolean;
    mode: ChannelStatsMode;
  }> = {},
) {
  const now = readPreviewClock(state.clock);
  const isOverviewMode = options.mode === 'overview';
  const activityItems = filterActivityItems(state.channelActivity, range, 'all', now);
  const joined = activityItems.filter((item) => item.type === 'joined').length;
  const left = activityItems.filter((item) => item.type === 'left').length;
  const { from, to } = resolveRangeWindow(range, now);
  const bucket: ChannelStatsBucket = range === '24h' ? 'hour' : 'day';
  const bucketStarts = buildPreviewStatsBucketStarts(from, to, bucket);
  const points = bucketStarts.length;

  function distributeTotal(total: number, weights: number[]): number[] {
    if (total <= 0) {
      return Array.from({ length: weights.length }, () => 0);
    }

    const safeWeights = weights.map((weight) => Math.max(0, weight));
    const totalWeight = safeWeights.reduce((sum, weight) => sum + weight, 0);
    if (totalWeight <= 0) {
      const fallback = Array.from({ length: weights.length }, () => 0);
      for (let index = 0; index < total; index += 1) {
        fallback[index % fallback.length] += 1;
      }
      return fallback;
    }

    const raw = safeWeights.map((weight) => (weight / totalWeight) * total);
    const distributed = raw.map((value) => Math.floor(value));
    let remainder = total - distributed.reduce((sum, value) => sum + value, 0);
    const fractions = raw
      .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
      .sort((leftItem, rightItem) => rightItem.fraction - leftItem.fraction);

    for (let index = 0; index < fractions.length && remainder > 0; index += 1) {
      distributed[fractions[index]!.index] += 1;
      remainder -= 1;
    }

    return distributed;
  }

  const joinedWeights = Array.from({ length: points }, (_, index) => {
    const progress = points > 1 ? index / (points - 1) : 0;
    return 1 + progress * (range === '24h' ? 0.45 : 0.9);
  });
  const leftWeights = Array.from({ length: points }, (_, index) => {
    if (index % 4 === 0) {
      return range === '24h' ? 0.2 : 0.25;
    }

    const progress = points > 1 ? index / (points - 1) : 0;
    return 0.75 + (1 - progress) * 0.45;
  });
  const joinedDistribution = distributeTotal(joined, joinedWeights);
  const leftDistribution = distributeTotal(left, leftWeights);
  const baseParticipants =
    state.channelHeaderParticipantsCount -
    joinedDistribution.reduce((sum, value) => sum + value, 0) +
    leftDistribution.reduce((sum, value) => sum + value, 0);

  let runningParticipants = baseParticipants;
  const membershipSeries = Array.from({ length: points }, (_, index) => {
    const at = bucketStarts[index] ?? to;
    const joinedValue = joinedDistribution[index] ?? 0;
    const leftValue = leftDistribution[index] ?? 0;
    return {
      at: at.toISOString(),
      joined: joinedValue,
      left: leftValue,
    };
  });
  const participantsSeries = membershipSeries.map((item) => {
    runningParticipants = Math.max(0, runningParticipants + item.joined - item.left);
    return {
      at: item.at,
      participantsCount: runningParticipants,
      source: 'flow' as const,
      confidence: 'medium' as const,
    };
  });
  const viewWeights = Array.from({ length: points }, (_, index) => {
    const progress = points > 1 ? index / (points - 1) : 0;
    const campaignLift = index === Math.floor(points * 0.62) ? 2.2 : 0;
    const latePulse = index >= points - 2 ? 0.9 : 0;
    return 1 + progress * 0.9 + campaignLift + latePulse;
  });
  const posts = range === '24h' ? 3 : range === '7d' ? 14 : 42;
  const postDistribution = distributeTotal(posts, viewWeights);
  const targetViews = range === '24h' ? 38_400 : range === '7d' ? 78_000 : 248_000;
  const viewsDistribution = distributeTotal(
    targetViews,
    postDistribution.map((postCount, index) =>
      postCount > 0 ? viewWeights[index]! * postCount : 0,
    ),
  );
  const viewsSeries = Array.from({ length: points }, (_, index) => {
    const at = bucketStarts[index] ?? to;
    const postCount = postDistribution[index] ?? 0;
    const viewCount = viewsDistribution[index] ?? 0;
    return {
      at: at.toISOString(),
      posts: postCount,
      views: postCount > 0 ? Math.round(viewCount / postCount) : 0,
    };
  });
  const views = viewsDistribution.reduce((sum, item) => sum + item, 0);
  const reactions = Math.round(views * 0.06);
  const previousFrom = new Date(from.getTime() - (to.getTime() - from.getTime()));
  const previousTo = new Date(from.getTime() - 1);
  const previousViews = Math.round(views * 0.84);
  const previousPosts = Math.max(1, Math.round(posts * 0.88));
  const previousReactions = Math.round(reactions * 0.76);
  const previousBucketStarts = buildPreviewStatsBucketStarts(previousFrom, previousTo, bucket);
  const previousNet = Math.round((joined - left) * 0.62);
  const previousJoined = Math.round(joined * 0.78);
  const previousLeft = Math.round(left * 1.18);
  const previousJoinedDistribution = distributeTotal(previousJoined, joinedWeights);
  const previousLeftDistribution = distributeTotal(previousLeft, leftWeights);
  const previousPostDistribution = distributeTotal(previousPosts, viewWeights);
  const previousViewsDistribution = distributeTotal(
    previousViews,
    previousPostDistribution.map((postCount, index) =>
      postCount > 0 ? viewWeights[index]! * postCount : 0,
    ),
  );
  const previousMembershipSeries = Array.from(
    { length: previousBucketStarts.length },
    (_, index) => {
      const at = previousBucketStarts[index] ?? previousTo;
      return {
        at: at.toISOString(),
        joined: previousJoinedDistribution[index] ?? 0,
        left: previousLeftDistribution[index] ?? 0,
      };
    },
  );
  let previousRunningParticipants =
    baseParticipants - Math.max(0, previousNet) + Math.max(0, joined - left - previousNet);
  const previousParticipantsSeries = previousMembershipSeries.map((item) => {
    previousRunningParticipants = Math.max(
      0,
      previousRunningParticipants + item.joined - item.left,
    );
    return {
      at: item.at,
      participantsCount: previousRunningParticipants,
      source: 'flow' as const,
      confidence: 'medium' as const,
    };
  });
  const previousViewsSeries = Array.from({ length: previousBucketStarts.length }, (_, index) => {
    const at = previousBucketStarts[index] ?? previousTo;
    const postCount = previousPostDistribution[index] ?? 0;
    const value = previousViewsDistribution[index] ?? 0;
    return {
      at: at.toISOString(),
      posts: postCount,
      views: postCount > 0 ? Math.round(value / postCount) : 0,
    };
  });
  const previousAverageViewsPerPost = Math.round(previousViews / previousPosts);
  const dailySummary = Array.from({ length: 16 }, (_, index) => {
    const dayOffset = 15 - index;
    const date = formatMoscowDateKey(addDays(now, -dayOffset));
    const delta = Math.round((joined - left) / 16 + Math.sin(index / 2) * 2);
    const churn = range === '24h' ? 1 : 2 + (index % 3);
    const joinedValue = Math.max(0, delta) + churn;
    const leftValue = Math.max(0, -delta) + Math.max(0, churn - 1);
    return {
      date,
      subscribers: Math.max(0, state.channelHeaderParticipantsCount - dayOffset * 3 + delta),
      delta,
      joined: joinedValue,
      left: leftValue,
      source: 'flow' as const,
      confidence: 'medium' as const,
    };
  });
  const summaryLast24h = range === '24h' ? views : Math.round(views * 0.28);
  const summaryLast48h = range === '24h' ? views : Math.round(views * 0.44);
  const summaryLast24hPerPost = Math.round(summaryLast24h / Math.max(1, posts));
  const summaryLast48hPerPost = Math.round(summaryLast48h / Math.max(1, posts));
  const selectedPeriodAverageViewsPerPost = Math.round(views / Math.max(1, posts));
  const summaryEr24 =
    summaryLast24h > 0 ? Math.round((reactions / summaryLast24h) * 10_000) / 100 : null;
  const reachAverageViews24h = 4_480;
  const reachAverageViews48h = 5_120;
  const reachSampleSize24h = 18;
  const reachSampleSize48h = 16;
  const reachErr48Percent =
    state.channelHeaderParticipantsCount > 0
      ? Math.round((reachAverageViews48h / state.channelHeaderParticipantsCount) * 100 * 10) / 10
      : null;
  const todayFrom = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  todayFrom.setUTCHours(0, 0, 0, 0);
  todayFrom.setUTCHours(todayFrom.getUTCHours() - 3);
  const todayActivityItems = state.channelActivity.filter(
    (item) => new Date(item.createdAt).getTime() >= todayFrom.getTime(),
  );
  const todayJoined = todayActivityItems.filter((item) => item.type === 'joined').length;
  const todayLeft = todayActivityItems.filter((item) => item.type === 'left').length;
  const todayDelta = todayJoined - todayLeft;
  const todaySummary = dailySummary.at(-1);
  if (todaySummary) {
    todaySummary.subscribers = state.channelHeaderParticipantsCount;
    todaySummary.delta = todayDelta;
    todaySummary.joined = todayJoined;
    todaySummary.left = todayLeft;
  }
  const topPosts = Array.from({ length: Math.min(5, posts) }, (_, index) => {
    const postViews = Math.round(4_800 - index * 520 + (range === '30d' ? 1_400 : 0));
    const previewUrls = [
      'https://major-maksimov.ru/app/favicon.png',
      'https://major-maksimov.ru/app/apple-touch-icon.png',
    ];
    return {
      messageId: `preview-channel-post-${index + 1}`,
      publishedAt: addHours(now, -4 - index * 11).toISOString(),
      url: `https://max.ru/channels/yuzhnoe-news/${index + 1}`,
      previewUrl: previewUrls[index] ?? null,
      viewsDelta: Math.round(postViews * (0.62 - index * 0.05)),
    };
  });
  const buildDelta = (current: number, previous: number) => ({
    current,
    previous,
    absolute: current - previous,
    percent:
      previous === 0
        ? current === 0
          ? 0
          : null
        : Math.round(((current - previous) / previous) * 1000) / 10,
  });
  const topReactions = [
    { emoji: '🔥', count: 182 },
    { emoji: '👍', count: 133 },
    { emoji: '❤️', count: 97 },
  ];
  const bestWindows = [
    {
      dayOfWeek: 4,
      hour: 18,
      score: 6200,
      posts: 3,
      averageViews: 5800,
      averageReactions: 310,
    },
    {
      dayOfWeek: 2,
      hour: 12,
      score: 5200,
      posts: 2,
      averageViews: 4900,
      averageReactions: 250,
    },
    {
      dayOfWeek: 6,
      hour: 11,
      score: 4700,
      posts: 2,
      averageViews: 4400,
      averageReactions: 220,
    },
  ];
  const response: ChannelStatsResponse = {
    channel: {
      id: channelId,
      title: resolveChannelTitle(channelId, state),
      participantsCount: state.channelHeaderParticipantsCount,
      status: 'Публичный канал',
      isPublic: true,
      link: 'https://max.ru/channels/yuzhnoe-news',
      lastEventAt: state.channelActivity[0]?.createdAt ?? null,
      avatarUrl: resolveChannelAvatarUrl(channelId, state),
    },
    period: {
      range,
      from: from.toISOString(),
      to: to.toISOString(),
      bucket,
    },
    official: {
      audience: {
        joined,
        left,
        net: joined - left,
      },
      content: {
        posts,
        views,
        reactions,
        topReactions: isOverviewMode ? [] : topReactions,
        topPosts: isOverviewMode ? [] : topPosts,
        lastPublishedAt: addHours(now, -3).toISOString(),
      },
      series: {
        participants: participantsSeries,
        membership: membershipSeries,
        views: viewsSeries,
      },
    },
    summary: {
      subscribers: {
        current: state.channelHeaderParticipantsCount,
        todayDelta,
        todayJoined,
        todayLeft,
        weekDelta: dailySummary.slice(-7).reduce((sum, item) => sum + (item.delta ?? 0), 0),
        sixteenDaysDelta: dailySummary.reduce((sum, item) => sum + (item.delta ?? 0), 0),
      },
      views: {
        perPost: summaryLast24hPerPost,
        last24h: summaryLast24hPerPost,
        last48h: summaryLast48hPerPost,
        er24: summaryEr24,
      },
      reach: {
        averageViews24h: reachAverageViews24h,
        averageViews48h: reachAverageViews48h,
        err48Percent: reachErr48Percent,
        subscriberDenominator: state.channelHeaderParticipantsCount,
        sampleSize24h: reachSampleSize24h,
        sampleSize48h: reachSampleSize48h,
        coverage24h: 'ready',
        coverage48h: 'ready',
        asOf: now.toISOString(),
        method: 'post-age-cohort',
      },
      daily: dailySummary,
    },
    secondary: {
      postsWithButtons: range === '24h' ? 1 : range === '7d' ? 5 : 12,
      comments: range === '24h' ? 46 : range === '7d' ? 281 : 970,
      suggestions: range === '24h' ? 5 : range === '7d' ? 17 : 63,
      commentAuthors: range === '24h' ? 31 : range === '7d' ? 118 : 366,
      suggestionAuthors: range === '24h' ? 4 : range === '7d' ? 13 : 44,
      suggestionsDelivered: range === '24h' ? 5 : range === '7d' ? 16 : 61,
      suggestionsFailed: range === '24h' ? 0 : range === '7d' ? 1 : 2,
      lastBotActivityAt: addHours(now, -1.8).toISOString(),
    },
    meta: {
      maxSnapshotAvailable: true,
      viewsAvailable: true,
      churnAvailable: true,
      officialCoverageFrom: addDays(now, -30).toISOString(),
      refreshQueued: false,
    },
    comparison: {
      period: {
        from: previousFrom.toISOString(),
        to: previousTo.toISOString(),
      },
      deltas: {
        audienceNet: buildDelta(joined - left, previousNet),
        joined: buildDelta(joined, previousJoined),
        left: buildDelta(left, previousLeft),
        posts: buildDelta(posts, previousPosts),
        views: buildDelta(views, previousViews),
        averageViewsPerPost: buildDelta(
          selectedPeriodAverageViewsPerPost,
          isOverviewMode ? 0 : previousAverageViewsPerPost,
        ),
        reactions: buildDelta(reactions, previousReactions),
      },
      ...(isOverviewMode
        ? {}
        : {
            series: {
              participants: previousParticipantsSeries,
              membership: previousMembershipSeries,
              views: previousViewsSeries,
            },
          }),
    },
    signals: {
      markers: [
        ...(isOverviewMode
          ? []
          : [
              {
                code: 'top-post' as const,
                type: 'post' as const,
                label: '#1',
                value: '4 800',
                tone: 'accent' as const,
                at: topPosts[0]?.publishedAt ?? addHours(now, -4).toISOString(),
              },
            ]),
        {
          code: 'views-peak',
          type: 'peak',
          label: 'Пик',
          value: '18 000',
          tone: 'success',
          at: viewsSeries[Math.floor(viewsSeries.length * 0.62)]?.at ?? now.toISOString(),
        },
      ],
      bestWindows: isOverviewMode ? [] : bestWindows,
    },
    activityFeed:
      options.includeActivityPreview === false
        ? { items: [], hasMore: false, nextCursor: null }
        : buildActivityPage(state.channelActivity, { range, limit: 50 }, now),
  };

  return channelStatsResponseSchema.parse(response);
}

function handleChatEventsPreviewRequest(
  state: PreviewState,
  chatId: string,
  tail: string[],
  url: URL,
  method: string,
  init: RequestInit,
): unknown | typeof PREVIEW_NOT_HANDLED {
  if (tail[0] === 'sanctions' && method === 'GET') {
    return cloneJson(
      buildPreviewSanctionsPage(state.chatViolations, url, readPreviewClock(state.clock)),
    );
  }
  if (tail[0] === 'logs-dashboard' && method === 'GET') {
    const range = (url.searchParams.get('range') as LogsDashboardRange | null) ?? '7d';
    return cloneJson(
      buildLogsDashboard(state, chatId, range, {
        includeActivityPreview: url.searchParams.get('includeActivityPreview') !== 'false',
        includeModerationPreview: url.searchParams.get('includeModerationPreview') !== 'false',
      }),
    );
  }

  if (tail[0] === 'moderation-dashboard' && method === 'GET') {
    const range = (url.searchParams.get('range') as LogsDashboardRange | null) ?? '7d';
    return cloneJson(
      buildLogsDashboard(state, chatId, range, {
        includeActivityPreview: false,
        includeModerationPreview: true,
      }),
    );
  }

  if (tail[0] === 'activity-dashboard' && method === 'GET') {
    const range = (url.searchParams.get('range') as LogsDashboardRange | null) ?? '7d';
    return cloneJson(
      buildLogsDashboard(state, chatId, range, {
        includeActivityPreview: true,
        includeModerationPreview: false,
      }),
    );
  }

  if (tail[0] === 'moderation-feed' && method === 'GET') {
    return cloneJson(
      buildModerationFeedPage(
        state.chatViolations,
        {
          range: (url.searchParams.get('range') as LogsDashboardRange | null) ?? '7d',
          filter: (url.searchParams.get('filter') as ModerationFeedFilter | null) ?? 'ALL',
          limit: Number.parseInt(url.searchParams.get('limit') ?? '50', 10),
          cursor: url.searchParams.get('cursor'),
        },
        readPreviewClock(state.clock),
      ),
    );
  }

  if (tail[0] === 'activity-feed' && method === 'GET') {
    return cloneJson(
      buildActivityPage(
        state.chatActivity,
        {
          range: (url.searchParams.get('range') as MembershipActivityRange | null) ?? '7d',
          filter: (url.searchParams.get('filter') as MembershipActivityFilter | null) ?? 'all',
          limit: Number.parseInt(url.searchParams.get('limit') ?? '50', 10),
          cursor: url.searchParams.get('cursor'),
        },
        readPreviewClock(state.clock),
      ),
    );
  }

  if (tail[0] === 'spammer-review' && tail[1] === 'metrics' && method === 'GET') {
    return cloneJson(buildPreviewSpammerReviewMetrics(state.spammerReviewCandidates, state.clock));
  }

  if (tail[0] === 'spammer-diagnostics' && tail[1] && method === 'GET') {
    const includeProfile =
      url.searchParams.get('includeProfile') !== 'false' &&
      url.searchParams.get('includeProfiles') !== 'false';
    return cloneJson(
      buildPreviewSpammerDiagnostics(
        state.spammerReviewCandidates,
        chatId,
        decodeURIComponent(tail[1]),
        state.clock,
        includeProfile,
      ),
    );
  }

  if (tail[0] === 'spammer-review' && tail.length === 1 && method === 'GET') {
    const status = url.searchParams.get('status') ?? 'PENDING';
    const limit = Math.max(
      1,
      Math.min(Number.parseInt(url.searchParams.get('limit') ?? '50', 10), 100),
    );
    const items = state.spammerReviewCandidates
      .filter((candidate) => status === 'ALL' || candidate.status === status)
      .slice(0, limit);
    return cloneJson(
      globalSpammerReviewQueueSchema.parse({
        items,
        limit,
      }),
    );
  }

  if (tail[0] === 'spammer-review' && tail[1] && method === 'POST') {
    const userId = decodeURIComponent(tail[1]);
    const payload = globalSpammerReviewRequestSchema.parse(
      parseJsonBody(init) as GlobalSpammerReviewRequest,
    );
    return cloneJson(
      createPreviewSpammerReviewResult(state.spammerReviewCandidates, userId, payload, state.clock),
    );
  }

  if (tail[0] === 'members' && tail.length <= 2 && method === 'GET') {
    if (tail[1])
      return cloneJson(buildPreviewParticipantDetails(state, decodeURIComponent(tail[1]), url));
    const now = readPreviewClock(state.clock);
    return cloneJson(
      buildParticipantsPage(
        state.chatParticipants,
        {
          range: (url.searchParams.get('range') as LogsDashboardRange | null) ?? '7d',
          limit: Number.parseInt(url.searchParams.get('limit') ?? '100', 10),
          cursor: url.searchParams.get('cursor'),
          search: url.searchParams.get('search'),
          activityFilter:
            (url.searchParams.get('activityFilter') as ChatParticipantsQuery['activityFilter']) ??
            'all',
          roleFilter:
            (url.searchParams.get('roleFilter') as ChatParticipantsQuery['roleFilter'] | null) ??
            'all',
        },
        state.chatParticipants.length,
        state.chatViolations,
        now,
      ),
    );
  }

  if (tail[0] === 'members' && tail[1] === 'unavailable-cleanup' && method === 'POST') {
    const payload = chatUnavailableParticipantsCleanupRequestSchema.parse(
      parseJsonBody(init) as ChatUnavailableParticipantsCleanupRequest,
    );
    return cloneJson(
      chatUnavailableParticipantsCleanupResultSchema.parse({
        ok: true,
        dryRun: payload.dryRun,
        scannedCount: state.chatParticipants.length,
        matchedCount: 0,
        removedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        scanLimitReached: false,
        items: [],
        message: 'Безопасных кандидатов не найдено.',
      }),
    );
  }

  if (tail[0] === 'members' && tail[1] && tail[2] === 'moderation-action' && method === 'POST') {
    const userId = decodeURIComponent(tail[1]);
    const payload = manualModerationActionRequestSchema.parse(parseJsonBody(init));
    return applyPreviewManualModeration(state, userId, payload);
  }

  if (tail[0] === 'members' && tail[1] && tail[2] === 'immunity' && method === 'PUT') {
    const userId = decodeURIComponent(tail[1]);
    const payload = chatParticipantImmunityUpdateRequestSchema.parse(
      parseJsonBody(init) as ChatParticipantImmunityUpdateRequest,
    );
    const immunity = payload.enabled
      ? payload.mode === 'always'
        ? createPreviewAlwaysImmunity()
        : createPreviewImmunity(payload.durationHours!, payload.dailyViolationLimit!, state.clock)
      : null;

    state.chatParticipants = state.chatParticipants.map((item) =>
      item.userId === userId
        ? {
            ...item,
            immunity,
          }
        : item,
    );

    return chatParticipantImmunityUpdateResultSchema.parse({
      immunity,
      message: payload.enabled ? 'Иммунитет обновлён.' : 'Иммунитет снят.',
    });
  }

  return PREVIEW_NOT_HANDLED;
}

function handleChannelEventsPreviewRequest(
  state: PreviewState,
  channelId: string,
  tail: string[],
  url: URL,
  method: string,
): unknown | typeof PREVIEW_NOT_HANDLED {
  if (tail[0] === 'members' && tail[1] && tail[2] === 'ban' && method === 'POST') {
    const targetUserId = decodeURIComponent(tail[1]);
    const member = state.channelActivity.find((item) => item.userId === targetUserId);
    if (!member) throw new Error('Участник не найден.');
    if (member.type === 'left') throw new Error('Участник уже вышел из канала или был удалён.');
    state.channelActivity.unshift({
      ...member,
      id: `channel-ban-${targetUserId}-${readPreviewClock(state.clock).getTime()}`,
      type: 'left',
      createdAt: readPreviewClock(state.clock).toISOString(),
    });
    return {
      ...createModerationResult(
        targetUserId,
        { action: 'BAN', scope: 'current_chat' },
        state.clock,
      ),
      message: 'Бан включён.',
    };
  }
  if (tail[0] === 'stats' && method === 'GET') {
    const range = (url.searchParams.get('range') as ChannelStatsRange | null) ?? '7d';
    const mode = (url.searchParams.get('mode') as ChannelStatsMode | null) ?? undefined;
    return cloneJson(
      buildChannelStats(state, channelId, range, {
        includeActivityPreview: url.searchParams.get('includeActivityPreview') !== 'false',
        mode,
      }),
    );
  }

  if (tail[0] === 'activity-feed' && method === 'GET') {
    return cloneJson(
      buildActivityPage(
        state.channelActivity,
        {
          range: (url.searchParams.get('range') as MembershipActivityRange | null) ?? '7d',
          filter: (url.searchParams.get('filter') as MembershipActivityFilter | null) ?? 'all',
          limit: Number.parseInt(url.searchParams.get('limit') ?? '50', 10),
          cursor: url.searchParams.get('cursor'),
        },
        readPreviewClock(state.clock),
      ),
    );
  }

  return PREVIEW_NOT_HANDLED;
}

const CHAT_EVENT_ROOTS = new Set([
  'sanctions',
  'logs-dashboard',
  'moderation-dashboard',
  'activity-dashboard',
  'moderation-feed',
  'activity-feed',
  'spammer-review',
  'spammer-diagnostics',
  'members',
]);
const CHANNEL_EVENT_ROOTS = new Set(['stats', 'activity-feed', 'members']);

export const handleEventsPreviewRequest: PreviewRequestHandler = async (context) => {
  const entity = resolvePreviewEntityRequest(context);
  if (
    !entity ||
    !(entity.entityType === 'chat'
      ? CHAT_EVENT_ROOTS.has(entity.tail[0] ?? '')
      : CHANNEL_EVENT_ROOTS.has(entity.tail[0] ?? ''))
  ) {
    return PREVIEW_NOT_HANDLED;
  }
  if (
    context.state.moderationActionDelayMs > 0 &&
    entity.tail[0] === 'members' &&
    entity.tail[1] &&
    (entity.tail[2] === 'moderation-action' || entity.tail[2] === 'ban') &&
    context.method === 'POST'
  ) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, context.state.moderationActionDelayMs);
    });
  }
  return entity.entityType === 'chat'
    ? handleChatEventsPreviewRequest(
        context.state,
        entity.entityId,
        entity.tail,
        context.url,
        context.method,
        context.init,
      )
    : handleChannelEventsPreviewRequest(
        context.state,
        entity.entityId,
        entity.tail,
        context.url,
        context.method,
      );
};
