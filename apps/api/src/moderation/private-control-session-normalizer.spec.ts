import { DEFAULT_BROADCAST_DRAFT } from './private-control.constants';
import {
  createDefaultPrivateControlSession,
  normalizePrivateControlPendingInput,
  normalizePrivateControlPendingMassAction,
  normalizePrivateControlSession,
  parsePrivateControlScreen,
  toPrivateControlPositiveInt,
} from './private-control-session-normalizer';
import type { PrivateBroadcastDraft, PrivateSuggestionDraft } from './private-control.types';

const defaultNormalizerDeps = {
  normalizeBroadcastDraft: () => ({ ...DEFAULT_BROADCAST_DRAFT }),
  normalizeSuggestionDraft: () => null,
};

describe('private control session normalizer', () => {
  it('creates the canonical default session', () => {
    expect(createDefaultPrivateControlSession()).toEqual({
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
      broadcastDraft: DEFAULT_BROADCAST_DRAFT,
      suggestionDraft: null,
    });

    expect(normalizePrivateControlSession(null, defaultNormalizerDeps)).toEqual(
      createDefaultPrivateControlSession(),
    );
  });

  it('normalizes persisted scalar fields and delegates draft normalization', () => {
    const broadcastDraft: PrivateBroadcastDraft = {
      ...DEFAULT_BROADCAST_DRAFT,
      text: 'scheduled post',
    };
    const suggestionDraft: PrivateSuggestionDraft = {
      chatId: 'channel-1',
      token: 'token-1',
      text: 'suggestion',
      textFormat: 'plain',
      textMarkup: [],
      images: [],
      video: null,
      mediaBotId: null,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      sourceMessageId: null,
      previewMessageId: null,
    };
    const normalizeBroadcastDraft = jest.fn(() => broadcastDraft);
    const normalizeSuggestionDraft = jest.fn(() => suggestionDraft);
    const stack = Array.from({ length: 25 }, (_, index) => `screen-${index}`);

    const session = normalizePrivateControlSession(
      {
        lastPrivateChatId: ' private-chat ',
        lastPrivateBotId: ' 888000_bot ',
        lastBroadcastHandoffDeliveredChatId: ' broadcast-chat ',
        lastBroadcastHandoffDeliveredAt: Number.NaN,
        lastGiveawayHandoffDeliveredAt: 123,
        pendingProfileMentionChatId: ' mention-chat ',
        pendingProfileMentionUserId: ' mention-user ',
        pendingProfileMentionDisplayName: ' Mention User ',
        selectedChatId: ' selected-chat ',
        selectedEntityType: 'bogus',
        entityTab: 'channel',
        uiMode: 'legacy',
        screen: 'main',
        homeTab: 'all',
        sectionView: 'advanced',
        searchQuery: ' moderation ',
        lastScreenStack: ['', 42, ...stack],
        broadcastView: 'advanced',
        section: 'night',
        channelSection: 'comments',
        chatPage: '4',
        domainPage: 0,
        eventsPage: 'bad',
        manualPage: 3.8,
        logsRange: '30d',
        manualTargetUserId: ' target-user ',
        broadcastDraft: { raw: 'broadcast' },
        suggestionDraft: { raw: 'suggestion' },
      },
      {
        normalizeBroadcastDraft,
        normalizeSuggestionDraft,
      },
    );

    expect(session).toEqual(
      expect.objectContaining({
        lastPrivateChatId: 'private-chat',
        lastPrivateBotId: '888000_bot',
        lastBroadcastHandoffDeliveredChatId: 'broadcast-chat',
        lastBroadcastHandoffDeliveredAt: null,
        lastGiveawayHandoffDeliveredAt: 123,
        pendingProfileMentionChatId: 'mention-chat',
        pendingProfileMentionUserId: 'mention-user',
        pendingProfileMentionDisplayName: 'Mention User',
        selectedChatId: 'selected-chat',
        selectedEntityType: 'chat',
        entityTab: 'channel',
        uiMode: 'modern',
        screen: 'home',
        homeTab: 'all',
        sectionView: 'advanced',
        searchQuery: 'moderation',
        lastScreenStack: stack.slice(-20),
        broadcastView: 'advanced',
        section: 'night',
        channelSection: 'comments',
        chatPage: 4,
        domainPage: 1,
        eventsPage: 1,
        manualPage: 3,
        logsRange: '30d',
        manualTargetUserId: 'target-user',
        broadcastDraft,
        suggestionDraft,
      }),
    );
    expect(normalizeBroadcastDraft).toHaveBeenCalledWith({ raw: 'broadcast' });
    expect(normalizeSuggestionDraft).toHaveBeenCalledWith({ raw: 'suggestion' });
  });

  it('keeps the readable Karavan chat title and accepts legacy flows without one', () => {
    const expiresAt = Date.now() + 60_000;
    const normalized = normalizePrivateControlSession(
      {
        pendingKaravanAllowlist: {
          chatId: ' chat-1 ',
          chatTitle: '  Команда MAX  ',
          actorUserId: ' user-1 ',
          botId: ' bot-1 ',
          nonce: ' nonce-1 ',
          stage: 'await_forward',
          targetUserId: null,
          targetDisplayName: null,
          sourceMessageId: null,
          expiresAt,
        },
      },
      defaultNormalizerDeps,
    );

    expect(normalized.pendingKaravanAllowlist).toEqual({
      chatId: 'chat-1',
      chatTitle: 'Команда MAX',
      actorUserId: 'user-1',
      botId: 'bot-1',
      nonce: 'nonce-1',
      stage: 'await_forward',
      targetUserId: null,
      targetDisplayName: null,
      sourceMessageId: null,
      expiresAt,
    });

    const legacy = normalizePrivateControlSession(
      {
        pendingKaravanAllowlist: {
          chatId: 'chat-1',
          actorUserId: 'user-1',
          nonce: 'nonce-1',
          stage: 'await_forward',
          expiresAt,
        },
      },
      defaultNormalizerDeps,
    );
    expect(legacy.pendingKaravanAllowlist?.chatTitle).toBeNull();
  });

  it('normalizes pending input variants', () => {
    expect(
      normalizePrivateControlPendingInput({
        kind: 'set_field',
        section: 'limits',
        key: 'maxMessageLength',
        type: 'number',
        min: 1,
        max: 5,
      }),
    ).toEqual({
      kind: 'set_field',
      section: 'limits',
      key: 'maxMessageLength',
      type: 'number',
      min: 1,
      max: 5,
    });
    expect(
      normalizePrivateControlPendingInput({
        kind: 'set_channel_field',
        section: 'comments',
        key: 'commentsEnabled',
        type: 'boolean',
      }),
    ).toEqual({
      kind: 'set_channel_field',
      section: 'comments',
      key: 'commentsEnabled',
      type: 'boolean',
      min: undefined,
      max: undefined,
    });
    expect(
      normalizePrivateControlPendingInput({
        kind: 'schedule_domain',
        domain: ' example.com ',
        domainLabel: ' Example ',
      }),
    ).toEqual({
      kind: 'schedule_domain',
      domain: 'example.com',
      domainLabel: 'Example',
    });
    expect(
      normalizePrivateControlPendingInput({
        kind: 'channel_suggestion',
        chatId: ' channel-1 ',
        token: ' token-1 ',
      }),
    ).toEqual({
      kind: 'channel_suggestion',
      chatId: 'channel-1',
      token: 'token-1',
    });
    expect(
      normalizePrivateControlPendingInput({
        kind: 'manual_mute_duration',
        targetUserId: ' user-1 ',
      }),
    ).toEqual({
      kind: 'manual_mute_duration',
      targetUserId: 'user-1',
    });
    expect(normalizePrivateControlPendingInput({ kind: 'giveaway_prize', index: '3' })).toEqual({
      kind: 'giveaway_prize',
      index: 2,
    });
    expect(normalizePrivateControlPendingInput({ kind: 'broadcast_text' })).toEqual({
      kind: 'broadcast_text',
    });

    expect(normalizePrivateControlPendingInput({ kind: 'set_field', section: 'bad' })).toBeNull();
    expect(
      normalizePrivateControlPendingInput({
        kind: 'set_field',
        section: 'thematicFilters',
        key: 'thematicCodewordEnabled',
        type: 'boolean',
      }),
    ).toBeNull();
    expect(normalizePrivateControlPendingInput({ kind: 'channel_suggestion' })).toBeNull();
    expect(normalizePrivateControlPendingInput({ kind: 'unknown' })).toBeNull();
  });

  it('normalizes pending mass actions', () => {
    expect(
      normalizePrivateControlPendingMassAction({
        kind: 'apply_section',
        section: 'links',
        targetChats: '7',
      }),
    ).toEqual({
      kind: 'apply_section',
      section: 'links',
      targetChats: 7,
    });
    expect(
      normalizePrivateControlPendingMassAction({
        kind: 'broadcast',
        targetChats: -1,
      }),
    ).toEqual({
      kind: 'broadcast',
      targetChats: 1,
    });

    expect(
      normalizePrivateControlPendingMassAction({
        kind: 'apply_section',
        section: 'bad',
      }),
    ).toBeNull();
    expect(
      normalizePrivateControlPendingMassAction({
        kind: 'apply_section',
        section: 'thematicFilters',
        targetChats: 7,
      }),
    ).toBeNull();
    expect(normalizePrivateControlPendingMassAction({ kind: 'unknown' })).toBeNull();
  });

  it('drops a retired thematic section from persisted sessions', () => {
    expect(
      normalizePrivateControlSession(
        {
          screen: 'section',
          section: 'thematicFilters',
        },
        defaultNormalizerDeps,
      ).section,
    ).toBeNull();
  });

  it('keeps legacy parser quirks centralized', () => {
    expect(parsePrivateControlScreen('main')).toBe('home');
    expect(parsePrivateControlScreen('manual_actions')).toBe('manual_actions');
    expect(parsePrivateControlScreen('bad')).toBe('home');
    expect(toPrivateControlPositiveInt('12px', 1)).toBe(12);
    expect(toPrivateControlPositiveInt(3.9, 1)).toBe(3);
    expect(toPrivateControlPositiveInt(0, 1)).toBe(1);
  });
});
