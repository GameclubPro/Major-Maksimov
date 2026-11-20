import type {
  ChannelSettings,
  ChatSettings,
  LogsDashboardRange,
  ManagedEntityType,
} from '@maxim/contracts';
import { DEFAULT_BROADCAST_DRAFT } from './private-control.constants';
import type {
  ChannelSectionKey,
  PendingInput,
  PendingKaravanAllowlistFlow,
  PendingMassAction,
  PrivateBroadcastDraft,
  PrivateBroadcastView,
  PrivateHomeTab,
  PrivateScreen,
  PrivateSectionKey,
  PrivateSectionView,
  PrivateSession,
  PrivateSuggestionDraft,
  PrivateUiMode,
  SettingFieldType,
} from './private-control.types';

const PRIVATE_SECTION_KEYS = [
  'links',
  'greeting',
  'profanityFilter',
  'commercialFilter',
  'duplicates',
  'limits',
  'night',
  'storefront',
  'extra',
] as const satisfies readonly PrivateSectionKey[];

export type PrivateControlSessionNormalizerDeps = {
  normalizeBroadcastDraft(raw: unknown): PrivateBroadcastDraft;
  normalizeSuggestionDraft(raw: unknown): PrivateSuggestionDraft | null;
};

export function createDefaultPrivateControlSession(): PrivateSession {
  return {
    version: 3,
    lastPrivateChatId: null,
    lastPrivateBotId: null,
    lastBroadcastHandoffDeliveredChatId: null,
    lastBroadcastHandoffDeliveredAt: null,
    lastGiveawayHandoffDeliveredChatId: null,
    lastGiveawayHandoffDeliveredAt: null,
    lastRulesHandoffDeliveredChatId: null,
    lastRulesHandoffDeliveredAt: null,
    lastProfileMentionHandoffDeliveredChatId: null,
    lastProfileMentionHandoffDeliveredAt: null,
    pendingProfileMentionChatId: null,
    pendingProfileMentionUserId: null,
    pendingProfileMentionDisplayName: null,
    pendingProfileMentionExpiresAt: null,
    pendingProfileMentionBotId: null,
    selectedChatId: null,
    selectedEntityType: null,
    managedGiveawayId: null,
    entityTab: 'chat',
    uiMode: 'modern',
    screen: 'home',
    homeTab: 'quick',
    sectionView: 'basic',
    searchQuery: null,
    lastScreenStack: [],
    broadcastView: 'basic',
    section: null,
    channelSection: null,
    chatPage: 1,
    domainPage: 1,
    eventsPage: 1,
    manualPage: 1,
    logsRange: '7d',
    manualTargetUserId: null,
    pendingInput: null,
    pendingKaravanAllowlist: null,
    pendingMassAction: null,
    broadcastDraft: {
      ...DEFAULT_BROADCAST_DRAFT,
    },
    suggestionDraft: null,
  };
}

export function normalizePrivateControlSession(
  raw: unknown,
  deps: PrivateControlSessionNormalizerDeps,
): PrivateSession {
  const fallback = createDefaultPrivateControlSession();
  if (!raw || typeof raw !== 'object') {
    return fallback;
  }

  const row = raw as Partial<PrivateSession>;
  const selectedChatId = nonEmptyTrimmedString(row.selectedChatId);
  const parsedSelectedEntityType = parsePrivateControlEntityType(row.selectedEntityType);

  return {
    version: 3,
    lastPrivateChatId: nonEmptyTrimmedString(row.lastPrivateChatId),
    lastPrivateBotId: nonEmptyTrimmedString(row.lastPrivateBotId),
    lastBroadcastHandoffDeliveredChatId: nonEmptyTrimmedString(
      row.lastBroadcastHandoffDeliveredChatId,
    ),
    lastBroadcastHandoffDeliveredAt: finiteNumberOrNull(row.lastBroadcastHandoffDeliveredAt),
    lastGiveawayHandoffDeliveredChatId: nonEmptyTrimmedString(
      row.lastGiveawayHandoffDeliveredChatId,
    ),
    lastGiveawayHandoffDeliveredAt: finiteNumberOrNull(row.lastGiveawayHandoffDeliveredAt),
    lastRulesHandoffDeliveredChatId: nonEmptyTrimmedString(row.lastRulesHandoffDeliveredChatId),
    lastRulesHandoffDeliveredAt: finiteNumberOrNull(row.lastRulesHandoffDeliveredAt),
    lastProfileMentionHandoffDeliveredChatId: nonEmptyTrimmedString(
      row.lastProfileMentionHandoffDeliveredChatId,
    ),
    lastProfileMentionHandoffDeliveredAt: finiteNumberOrNull(
      row.lastProfileMentionHandoffDeliveredAt,
    ),
    pendingProfileMentionChatId: nonEmptyTrimmedString(row.pendingProfileMentionChatId),
    pendingProfileMentionUserId: nonEmptyTrimmedString(row.pendingProfileMentionUserId),
    pendingProfileMentionDisplayName: nonEmptyTrimmedString(row.pendingProfileMentionDisplayName),
    pendingProfileMentionExpiresAt: finiteNumberOrNull(row.pendingProfileMentionExpiresAt),
    pendingProfileMentionBotId: nonEmptyTrimmedString(row.pendingProfileMentionBotId),
    selectedChatId,
    selectedEntityType: parsedSelectedEntityType ?? (selectedChatId ? 'chat' : null),
    managedGiveawayId: nonEmptyTrimmedString(row.managedGiveawayId),
    entityTab: parsePrivateControlEntityType(row.entityTab) ?? parsedSelectedEntityType ?? 'chat',
    uiMode: parsePrivateControlUiMode(row.uiMode),
    screen: parsePrivateControlScreen(row.screen),
    homeTab: parsePrivateControlHomeTab(row.homeTab),
    sectionView: parsePrivateControlSectionView(row.sectionView),
    searchQuery: nonEmptyTrimmedString(row.searchQuery),
    lastScreenStack: Array.isArray(row.lastScreenStack)
      ? row.lastScreenStack
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .slice(-20)
      : [],
    broadcastView: parsePrivateControlBroadcastView(row.broadcastView),
    section: parsePrivateControlSection(typeof row.section === 'string' ? row.section : undefined),
    channelSection: parsePrivateControlChannelSection(
      typeof row.channelSection === 'string' ? row.channelSection : undefined,
    ),
    chatPage: toPositiveInt(row.chatPage, 1),
    domainPage: toPositiveInt(row.domainPage, 1),
    eventsPage: toPositiveInt(row.eventsPage, 1),
    manualPage: toPositiveInt(row.manualPage, 1),
    logsRange: parsePrivateControlLogsRange(
      typeof row.logsRange === 'string' ? row.logsRange : undefined,
    ),
    manualTargetUserId: nonEmptyTrimmedString(row.manualTargetUserId),
    pendingInput: normalizePrivateControlPendingInput(row.pendingInput),
    pendingKaravanAllowlist: normalizePendingKaravanAllowlist(row.pendingKaravanAllowlist),
    pendingMassAction: normalizePrivateControlPendingMassAction(row.pendingMassAction),
    broadcastDraft: deps.normalizeBroadcastDraft(row.broadcastDraft),
    suggestionDraft: deps.normalizeSuggestionDraft(row.suggestionDraft),
  };
}

function normalizePendingKaravanAllowlist(raw: unknown): PendingKaravanAllowlistFlow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const chatId = typeof row.chatId === 'string' ? row.chatId.trim() : '';
  const chatTitle =
    typeof row.chatTitle === 'string' && row.chatTitle.trim() ? row.chatTitle.trim() : null;
  const actorUserId = typeof row.actorUserId === 'string' ? row.actorUserId.trim() : '';
  const nonce = typeof row.nonce === 'string' ? row.nonce.trim() : '';
  const botId = typeof row.botId === 'string' && row.botId.trim() ? row.botId.trim() : null;
  const stage =
    row.stage === 'await_duration'
      ? 'await_duration'
      : row.stage === 'await_forward'
        ? 'await_forward'
        : null;
  const expiresAt =
    typeof row.expiresAt === 'number' && Number.isFinite(row.expiresAt) ? row.expiresAt : 0;
  if (!chatId || !actorUserId || !nonce || !stage || expiresAt <= Date.now()) {
    return null;
  }
  return {
    chatId,
    chatTitle,
    actorUserId,
    botId,
    nonce,
    stage,
    targetUserId:
      typeof row.targetUserId === 'string' && row.targetUserId.trim()
        ? row.targetUserId.trim()
        : null,
    targetDisplayName:
      typeof row.targetDisplayName === 'string' && row.targetDisplayName.trim()
        ? row.targetDisplayName.trim()
        : null,
    sourceMessageId:
      typeof row.sourceMessageId === 'string' && row.sourceMessageId.trim()
        ? row.sourceMessageId.trim()
        : null,
    expiresAt,
  };
}

export function normalizePrivateControlPendingInput(raw: unknown): PendingInput | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const row = raw as Partial<PendingInput> & Record<string, unknown>;
  const kind = typeof row.kind === 'string' ? row.kind : null;
  if (!kind) {
    return null;
  }

  if (kind === 'set_field') {
    const section = parsePrivateControlSection(
      typeof row.section === 'string' ? row.section : undefined,
    );
    const key = typeof row.key === 'string' ? (row.key as keyof ChatSettings) : null;
    const type = parsePrivateControlSettingFieldType(
      typeof row.type === 'string' ? row.type : undefined,
    );
    if (!section || !key || !type) {
      return null;
    }

    return {
      kind,
      section,
      key,
      type,
      min: typeof row.min === 'number' ? row.min : undefined,
      max: typeof row.max === 'number' ? row.max : undefined,
    };
  }

  if (kind === 'set_channel_field') {
    const section = parsePrivateControlChannelSection(
      typeof row.section === 'string' ? row.section : undefined,
    );
    const key = typeof row.key === 'string' ? (row.key as keyof ChannelSettings) : null;
    const type = parsePrivateControlSettingFieldType(
      typeof row.type === 'string' ? row.type : undefined,
    );
    if (!section || !key || !type) {
      return null;
    }

    return {
      kind,
      section,
      key,
      type,
      min: typeof row.min === 'number' ? row.min : undefined,
      max: typeof row.max === 'number' ? row.max : undefined,
    };
  }

  if (kind === 'schedule_domain') {
    if (typeof row.domain !== 'string' || !row.domain.trim()) {
      return null;
    }
    return {
      kind,
      domain: row.domain.trim(),
      domainLabel:
        typeof row.domainLabel === 'string' && row.domainLabel.trim()
          ? row.domainLabel.trim()
          : row.domain.trim(),
    };
  }

  if (kind === 'channel_suggestion') {
    if (typeof row.chatId !== 'string' || !row.chatId.trim()) {
      return null;
    }
    if (typeof row.token !== 'string' || !row.token.trim()) {
      return null;
    }
    return {
      kind,
      chatId: row.chatId.trim(),
      token: row.token.trim(),
    };
  }

  if (kind === 'manual_mute_duration') {
    if (typeof row.targetUserId !== 'string' || !row.targetUserId.trim()) {
      return null;
    }
    return {
      kind,
      targetUserId: row.targetUserId.trim(),
    };
  }

  if (kind === 'giveaway_prize') {
    const index = toPositiveInt(row.index, 1) - 1;
    return {
      kind,
      index: Math.max(0, index),
    };
  }

  const allowedKinds: PendingInput['kind'][] = [
    'search_settings',
    'add_domain',
    'broadcast_content',
    'broadcast_text',
    'broadcast_button_url',
    'broadcast_button_text',
    'broadcast_send_at',
    'broadcast_cycle_every_hours',
    'broadcast_cycle_count',
    'broadcast_photo',
    'rules_text',
    'rules_photo',
    'channel_suggestion',
    'giveaway_title',
    'giveaway_content',
    'giveaway_description',
    'giveaway_start_at',
    'giveaway_end_at',
    'giveaway_claim_hours',
    'giveaway_photo',
    'support_request',
  ];

  if (allowedKinds.includes(kind as PendingInput['kind'])) {
    return {
      kind: kind as PendingInput['kind'],
    } as PendingInput;
  }

  return null;
}

export function normalizePrivateControlPendingMassAction(raw: unknown): PendingMassAction | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const row = raw as Partial<PendingMassAction> & Record<string, unknown>;
  if (row.kind === 'apply_section') {
    const section = parsePrivateControlSection(
      typeof row.section === 'string' ? row.section : undefined,
    );
    if (!section) {
      return null;
    }

    return {
      kind: 'apply_section',
      section,
      targetChats: toPositiveInt(row.targetChats, 1),
    };
  }

  if (row.kind === 'broadcast') {
    return {
      kind: 'broadcast',
      targetChats: toPositiveInt(row.targetChats, 1),
    };
  }

  return null;
}

export function parsePrivateControlSettingFieldType(
  value: string | undefined,
): SettingFieldType | null {
  if (
    value === 'boolean' ||
    value === 'number' ||
    value === 'text' ||
    value === 'url' ||
    value === 'enum' ||
    value === 'time' ||
    value === 'timezone'
  ) {
    return value;
  }

  return null;
}

export function parsePrivateControlScreen(value: unknown): PrivateScreen {
  if (
    value === 'chat_select' ||
    value === 'home' ||
    value === 'settings_hub' ||
    value === 'section' ||
    value === 'channel_section' ||
    value === 'domains' ||
    value === 'rules' ||
    value === 'broadcast' ||
    value === 'giveaway' ||
    value === 'events' ||
    value === 'logs' ||
    value === 'search' ||
    value === 'manual_users' ||
    value === 'manual_actions'
  ) {
    return value;
  }

  if (value === 'main') {
    return 'home';
  }

  return 'home';
}

export function parsePrivateControlEntityType(value: unknown): ManagedEntityType | null {
  if (value === 'chat' || value === 'channel') {
    return value;
  }

  return null;
}

export function parsePrivateControlUiMode(_value: unknown): PrivateUiMode {
  return 'modern';
}

export function parsePrivateControlHomeTab(value: unknown): PrivateHomeTab {
  return value === 'all' ? 'all' : 'quick';
}

export function parsePrivateControlSectionView(value: unknown): PrivateSectionView {
  return value === 'advanced' ? 'advanced' : 'basic';
}

export function parsePrivateControlBroadcastView(value: unknown): PrivateBroadcastView {
  return value === 'advanced' ? 'advanced' : 'basic';
}

export function parsePrivateControlSection(value: string | undefined): PrivateSectionKey | null {
  if (!value) {
    return null;
  }

  return PRIVATE_SECTION_KEYS.includes(value as PrivateSectionKey)
    ? (value as PrivateSectionKey)
    : null;
}

export function parsePrivateControlChannelSection(
  value: string | undefined,
): ChannelSectionKey | null {
  if (value === 'post_suggestions' || value === 'comments') {
    return value;
  }

  return null;
}

export function parsePrivateControlLogsRange(value: string | undefined): LogsDashboardRange {
  if (value === '24h' || value === '7d' || value === '30d') {
    return value;
  }

  return '7d';
}

export function toPrivateControlPositiveInt(value: unknown, fallback: number): number {
  return toPositiveInt(value, fallback);
}

function nonEmptyTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const rounded = Math.trunc(value);
    return rounded > 0 ? rounded : fallback;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return fallback;
}
