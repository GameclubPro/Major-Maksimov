import { describe, expect, it } from 'vitest';
import { chatSanctionItemSchema, chatSanctionsQuerySchema } from '../src/chat-sanctions';
import { chatParticipantsQuerySchema } from '../src/chat-participants';
import { manualModerationActionRequestSchema } from '../src/manual-moderation';

describe('chat sanction and activity contracts', () => {
  it('preserves local ban release capability without changing older sanction responses', () => {
    const item = {
      id: 'local-ban',
      userId: '42',
      userDisplayName: 'Alex',
      avatarUrl: null,
      profileHandoffUrl: null,
      action: 'BAN',
      status: 'active',
      ruleCode: 'MANUAL_BAN',
      reason: null,
      operator: 'ADMIN',
      actorDisplayName: null,
      createdAt: '2026-11-02T10:00:00.000Z',
      expiresAt: null,
      endedAt: null,
      permanent: true,
      releaseAction: 'UNBAN',
    };
    expect(chatSanctionItemSchema.parse(item).banOnRejoin).toBeUndefined();
    expect(chatSanctionItemSchema.parse({ ...item, banOnRejoin: true })).toMatchObject({
      banOnRejoin: true,
      releaseAction: 'UNBAN',
    });
  });
  it('defaults sanctions to active state without a journal range', () => {
    expect(chatSanctionsQuerySchema.parse({})).toEqual({
      status: 'active',
      action: 'all',
      limit: 30,
    });
    expect(chatSanctionsQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
  });
  it('only allows expected sanction identity for release actions', () => {
    expect(
      manualModerationActionRequestSchema.safeParse({
        action: 'UNBAN',
        expectedSanctionEventId: 's1',
      }).success,
    ).toBe(true);
    expect(
      manualModerationActionRequestSchema.safeParse({
        action: 'BAN',
        expectedSanctionEventId: 's1',
      }).success,
    ).toBe(false);
    expect(
      manualModerationActionRequestSchema.safeParse({
        action: 'UNMUTE',
        expectedSanctionEventId: '',
      }).success,
    ).toBe(false);
  });
  it('accepts activity thresholds separately from violation range', () => {
    expect(
      chatParticipantsQuerySchema.parse({ range: '24h', activityFilter: '90d' }),
    ).toMatchObject({ range: '24h', activityFilter: '90d' });
    expect(chatParticipantsQuerySchema.safeParse({ activityFilter: 'offline' }).success).toBe(
      false,
    );
  });
});
