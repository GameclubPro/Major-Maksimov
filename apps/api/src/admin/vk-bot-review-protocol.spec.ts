import {
  buildVkBotReviewFingerprint,
  isVkManualReviewMode,
  isDefiniteVkReviewSendRejection,
  parseVkBotReviewCallback,
  vkBotReviewCallback,
} from './vk-bot-review-protocol';

describe('VK bot review protocol', () => {
  it('recognizes only structured definitive MAX rejections as retry-safe', () => {
    expect(
      isDefiniteVkReviewSendRejection({ response: { status: 403, data: { code: 'chat.denied' } } }),
    ).toBe(true);
    for (const error of [
      new Error('timeout'),
      { response: { status: 403 } },
      { response: { status: 408, data: { code: 'timeout' } } },
      { response: { status: 500, data: { code: 'internal' } } },
    ]) {
      expect(isDefiniteVkReviewSendRejection(error)).toBe(false);
    }
  });
  const post = {
    contentHash: 'source-v1',
    text: 'Post',
    textFormat: 'plain',
    photoUrls: ['https://example.test/a.jpg'],
    videoUrls: [],
    linkUrls: [],
    isAdvertising: false,
    manualContentEditedAt: null,
  };
  const settings = {
    stripLinksEnabled: false,
    skipAdsEnabled: false,
    appendChannelLinkEnabled: false,
    channelLinkText: 'Channel',
  };

  it.each(['publish', 'reject', 'refresh', 'menu', 'pause', 'resume'] as const)(
    'roundtrips versioned %s callbacks',
    (action) => {
      expect(parseVkBotReviewCallback(vkBotReviewCallback(action, 'review-1', 12))).toEqual({
        action,
        id: 'review-1',
        revision: 12,
      });
    },
  );
  it.each([
    'vkr:v1:publish:review:0',
    'vkr:v1:publish:review:1:extra',
    'vkr:v1:delete:review:1',
    'psa:v1:publish:review',
    'vkr:v1:publish:../review:1',
  ])('rejects malformed callbacks: %s', (value) => {
    expect(parseVkBotReviewCallback(value)).toBeNull();
  });
  it('keeps both review modes outside automation', () => {
    expect(['REVIEW', 'BOT_REVIEW', 'QUEUE', 'IMMEDIATE'].map(isVkManualReviewMode)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
  it('binds content, media, formatting and applied content settings', () => {
    const hash = buildVkBotReviewFingerprint(post, settings);
    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      buildVkBotReviewFingerprint(post, {
        ...settings,
        sourceLinkEnabled: false,
        sourceLinkUrl: '',
        deleteAfterMinutes: null,
      }),
    ).toBe(hash);
    for (const patch of [
      { text: 'changed' },
      { contentHash: 'source-v2' },
      { photoUrls: [] },
      { textFormat: 'markdown' },
      { isAdvertising: true },
      { manualContentEditedAt: new Date() },
    ]) {
      expect(buildVkBotReviewFingerprint({ ...post, ...patch }, settings)).not.toBe(hash);
    }
    for (const patch of [
      { stripLinksEnabled: true },
      { skipAdsEnabled: true },
      { appendChannelLinkEnabled: true },
      { channelLinkText: 'Changed' },
      { sourceLinkEnabled: true },
      { sourceLinkEnabled: true, sourceLinkUrl: 'https://example.com/original' },
      { deleteAfterMinutes: 60 },
    ]) {
      expect(buildVkBotReviewFingerprint(post, { ...settings, ...patch })).not.toBe(hash);
    }
  });
});
