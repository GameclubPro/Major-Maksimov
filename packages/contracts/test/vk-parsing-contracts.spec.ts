import { describe, expect, it } from 'vitest';

import {
  publishVkParsingPostRequestSchema as rootPublishVkParsingPostRequestSchema,
  publishVkParsingPostResultSchema as rootPublishVkParsingPostResultSchema,
  vkParsingFeedSchema as rootVkParsingFeedSchema,
} from '@maxim/contracts';
import {
  VK_PARSING_DEFAULT_CHANNEL_LINK_TEXT,
  buildVkParsingSourceLink,
  vkParsingSettingsSchema,
  publishVkParsingPostRequestSchema,
  publishVkParsingPostResultSchema,
  rollbackVkParsingResultSchema,
  updateVkParsingSettingsRequestSchema,
  vkParsingFeedSchema,
  vkParsingPublishModeSchema,
  vkBotReviewSettingsRequestSchema,
} from '@maxim/contracts/vk-parsing';

describe('VK parsing contracts', () => {
  it('keeps bot approval distinct from closed Safety Desk review', () => {
    expect(vkParsingPublishModeSchema.parse('BOT_REVIEW')).toBe('BOT_REVIEW');
    expect(vkParsingPublishModeSchema.parse('REVIEW')).toBe('REVIEW');
    expect(
      vkBotReviewSettingsRequestSchema.parse({ action: 'CONNECT', recipientUserId: 'foreign' }),
    ).toEqual({ action: 'CONNECT' });
    expect(vkBotReviewSettingsRequestSchema.safeParse({ action: 'PUBLISH_ALL' }).success).toBe(
      false,
    );
  });
  it('keeps root and subpath schema identity aligned', () => {
    expect(rootPublishVkParsingPostRequestSchema).toBe(publishVkParsingPostRequestSchema);
    expect(rootPublishVkParsingPostResultSchema).toBe(publishVkParsingPostResultSchema);
    expect(rootVkParsingFeedSchema).toBe(vkParsingFeedSchema);
  });

  it('models manual publish and publisher rollback as asynchronous work', () => {
    expect(publishVkParsingPostResultSchema.shape.queued.parse(undefined)).toBe(0);
    expect(publishVkParsingPostResultSchema.shape.messageId.safeParse(undefined).success).toBe(
      true,
    );
    expect(rollbackVkParsingResultSchema.shape.queued.parse(undefined)).toBe(0);
  });

  it('preserves fail-safe feed defaults', () => {
    const parsed = vkParsingFeedSchema.parse({});

    expect(parsed.capabilities).toEqual({
      enabled: false,
      canUse: false,
      reasonCode: null,
      reason: null,
    });
    expect(parsed.settings).toEqual(
      expect.objectContaining({
        chatId: '',
        autoPublishEnabled: false,
        autoPublishKillSwitchEnabled: false,
        channelLinkText: VK_PARSING_DEFAULT_CHANNEL_LINK_TEXT,
        schedulerTimezone: 'Europe/Moscow',
      }),
    );
    expect(parsed.sources).toEqual([]);
    expect(parsed.posts).toEqual([]);
    expect(parsed.queue).toEqual([]);
  });

  it('keeps publish payload media rules intact', () => {
    expect(
      publishVkParsingPostRequestSchema.safeParse({
        photoUrls: ['https://example.com/photo.jpg'],
        videoUrls: ['https://example.com/video.mp4'],
      }).success,
    ).toBe(false);
    expect(publishVkParsingPostRequestSchema.safeParse({}).success).toBe(false);
    expect(
      publishVkParsingPostRequestSchema.safeParse({
        text: 'Новая запись',
        textFormat: 'markdown',
      }).success,
    ).toBe(true);
  });

  it('models autopublish mode changes as one explicit command', () => {
    expect(
      updateVkParsingSettingsRequestSchema.parse({
        autoPublishMode: 'AUTO',
      }),
    ).toEqual({
      autoPublishMode: 'AUTO',
    });
    expect(
      updateVkParsingSettingsRequestSchema.safeParse({ autoPublishMode: 'PAUSED' }).success,
    ).toBe(true);
    expect(
      updateVkParsingSettingsRequestSchema.safeParse({
        autoPublishMode: 'MANUAL',
        autoPublishEnabled: false,
      }).success,
    ).toBe(false);
  });
});

describe('VK attribution and deletion settings', () => {
  it('leaves existing installations unchanged', () => {
    expect(vkParsingSettingsSchema.parse({ chatId: 'channel' })).toMatchObject({
      sourceLinkEnabled: false,
      sourceLinkUrl: '',
      deleteAfterMinutes: null,
    });
  });
  it('validates explicit HTTPS attribution and a bounded whole-minute delay', () => {
    expect(
      updateVkParsingSettingsRequestSchema.parse({
        sourceLinkUrl: ' https://example.com/a?x=1&y=2 ',
        deleteAfterMinutes: 1440,
      }),
    ).toEqual({
      sourceLinkUrl: 'https://example.com/a?x=1&y=2',
      deleteAfterMinutes: 1440,
    });
    for (const sourceLinkUrl of [
      'javascript:alert(1)',
      'http://example.com',
      'https://user:secret@example.com',
      'https://exam\nple.com',
    ])
      expect(updateVkParsingSettingsRequestSchema.safeParse({ sourceLinkUrl }).success).toBe(false);
    for (const deleteAfterMinutes of [0, -1, 1.5, 43201])
      expect(updateVkParsingSettingsRequestSchema.safeParse({ deleteAfterMinutes }).success).toBe(
        false,
      );
    expect(updateVkParsingSettingsRequestSchema.parse({ deleteAfterMinutes: null })).toEqual({
      deleteAfterMinutes: null,
    });
  });
  it('uses each original or an explicit custom source with safe markup', () => {
    expect(
      buildVkParsingSourceLink('https://vk.com/wall-1_2', { sourceLinkEnabled: false }),
    ).toBeNull();
    expect(
      buildVkParsingSourceLink('https://vk.com/wall-1_2', { sourceLinkEnabled: true })?.url,
    ).toBe('https://vk.com/wall-1_2');
    expect(
      buildVkParsingSourceLink('https://vk.com/wall-1_2', {
        sourceLinkEnabled: true,
        sourceLinkUrl: 'https://example.com/a?x=1&y=2',
      })?.html,
    ).toBe('<a href="https://example.com/a?x=1&amp;y=2">Источник</a>');
  });
});
