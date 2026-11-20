import {
  buildPrivateGiveawayHandoffStartPayload,
  buildPrivateKaravanAllowlistStartPayload,
  buildPrivateProfileMentionStartPayload,
  parsePrivateGiveawayHandoffStartPayload,
  parsePrivateKaravanAllowlistStartPayload,
  parsePrivateProfileMentionStartPayload,
} from './private-control-handoff-start-payload';
import { MAX_BOT_START_MAX_LENGTH } from '../max/max-deep-link.util';
import {
  GIVEAWAY_HANDOFF_START_PAYLOAD,
  GIVEAWAY_HANDOFF_START_PREFIX,
  PROFILE_MENTION_START_PREFIX,
} from './private-control.constants';

const botToken = 'test-token';

function buildLegacyPayload(prefix: string, payload: unknown): string {
  return `${prefix}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

describe('private control handoff start payloads', () => {
  it('preserves the existing storefront payload for IDs that fit', () => {
    const flow = { chatId: '-123', actorUserId: '456', nonce: 'test_nonce-12345' };
    const payload = buildPrivateKaravanAllowlistStartPayload(flow, botToken);

    expect(payload).toMatch(/^ka2-/u);
    expect(parsePrivateKaravanAllowlistStartPayload(payload, [botToken])).toEqual(flow);
  });

  it.each([
    ['-9223372036854775808', '9223372036854775807'],
    ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'],
  ])(
    'preserves the signed storefront handoff when long IDs need a compact link',
    (chatId, actorUserId) => {
      const flow = { chatId, actorUserId, nonce: 'test_nonce-12345' };
      const payload = buildPrivateKaravanAllowlistStartPayload(flow, botToken);

      expect(payload).toMatch(/^ka3-/u);
      expect(payload.length).toBeLessThanOrEqual(MAX_BOT_START_MAX_LENGTH);
      expect(parsePrivateKaravanAllowlistStartPayload(payload, ['other-token', botToken])).toEqual(
        flow,
      );
      expect(parsePrivateKaravanAllowlistStartPayload(payload, ['other-token'])).toBeNull();
      expect(
        parsePrivateKaravanAllowlistStartPayload(payload.replace(actorUserId, 'other-user'), [
          botToken,
        ]),
      ).toBeNull();
    },
  );

  it('builds and parses compact giveaway handoff payloads when possible', () => {
    const payload = buildPrivateGiveawayHandoffStartPayload(
      {
        chatId: 'chat-1',
        entityType: 'chat',
        giveawayId: 'giveaway-1',
      },
      botToken,
    );

    expect(payload).toMatch(/^ggh2_/);
    expect(parsePrivateGiveawayHandoffStartPayload(payload, [botToken])).toEqual({
      chatId: 'chat-1',
      entityType: 'chat',
      giveawayId: 'giveaway-1',
    });
    expect(parsePrivateGiveawayHandoffStartPayload(payload, ['other-token'])).toBeNull();
  });

  it('falls back to legacy giveaway payloads for non-compact values', () => {
    const payload = buildPrivateGiveawayHandoffStartPayload(
      {
        chatId: '-1001234567890',
        entityType: 'channel',
        giveawayId: null,
      },
      '',
    );

    expect(payload.startsWith(GIVEAWAY_HANDOFF_START_PREFIX)).toBe(true);
    expect(parsePrivateGiveawayHandoffStartPayload(payload, [botToken])).toEqual({
      chatId: '-1001234567890',
      entityType: 'channel',
      giveawayId: null,
    });
  });

  it('rejects malformed giveaway handoff payloads', () => {
    expect(parsePrivateGiveawayHandoffStartPayload(null, [botToken])).toBeNull();
    expect(
      parsePrivateGiveawayHandoffStartPayload(GIVEAWAY_HANDOFF_START_PAYLOAD, [botToken]),
    ).toBeNull();
    expect(parsePrivateGiveawayHandoffStartPayload('not-giveaway', [botToken])).toBeNull();
    expect(
      parsePrivateGiveawayHandoffStartPayload(`${GIVEAWAY_HANDOFF_START_PREFIX}bad`, [botToken]),
    ).toBeNull();
    expect(
      parsePrivateGiveawayHandoffStartPayload(
        buildLegacyPayload(GIVEAWAY_HANDOFF_START_PREFIX, {
          v: 1,
          k: 'giveaway-handoff',
          c: ' ',
          e: 'chat',
          g: 'giveaway-1',
        }),
        [botToken],
      ),
    ).toBeNull();
  });

  it('builds and parses compact profile mention payloads when possible', () => {
    const payload = buildPrivateProfileMentionStartPayload(
      {
        chatId: 'chat-1',
        entityType: 'chat',
        userId: 'user-1',
        displayName: 'Мария',
      },
      botToken,
    );

    expect(payload).toMatch(/^pm2_/);
    expect(parsePrivateProfileMentionStartPayload(payload, [botToken])).toEqual({
      chatId: 'chat-1',
      entityType: 'chat',
      userId: 'user-1',
      displayName: 'Пользователь',
    });
  });

  it('falls back to legacy profile mention payloads and trims display names', () => {
    const payload = buildPrivateProfileMentionStartPayload(
      {
        chatId: '-1001234567890',
        entityType: 'channel',
        userId: 'user 1',
        displayName: ' Мария ',
      },
      '',
    );

    expect(payload.startsWith(PROFILE_MENTION_START_PREFIX)).toBe(true);
    expect(parsePrivateProfileMentionStartPayload(payload, [botToken])).toEqual({
      chatId: '-1001234567890',
      entityType: 'channel',
      userId: 'user 1',
      displayName: 'Мария',
    });
  });

  it('defaults blank legacy profile mention display names', () => {
    const payload = buildPrivateProfileMentionStartPayload(
      {
        chatId: 'chat-1',
        entityType: 'chat',
        userId: 'user-1',
        displayName: ' ',
      },
      '',
    );

    expect(parsePrivateProfileMentionStartPayload(payload, [botToken])?.displayName).toBe(
      'Пользователь',
    );
  });

  it('rejects malformed profile mention payloads', () => {
    expect(parsePrivateProfileMentionStartPayload(null, [botToken])).toBeNull();
    expect(parsePrivateProfileMentionStartPayload('not-profile', [botToken])).toBeNull();
    expect(
      parsePrivateProfileMentionStartPayload(`${PROFILE_MENTION_START_PREFIX}bad`, [botToken]),
    ).toBeNull();
    expect(
      parsePrivateProfileMentionStartPayload(
        buildLegacyPayload(PROFILE_MENTION_START_PREFIX, {
          v: 1,
          k: 'profile-mention',
          c: 'chat-1',
          e: 'bad',
          u: 'user-1',
          n: 'Мария',
        }),
        [botToken],
      ),
    ).toBeNull();
  });
});
