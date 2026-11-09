import { createHash } from 'node:crypto';
import { z } from 'zod';
import { publishVkParsingPostRequestSchema } from '@maxim/contracts';

export const VK_BOT_REVIEW_MODE = 'BOT_REVIEW';
export const VK_BOT_REVIEW_CALLBACK_PREFIX = 'vkr:v1:';
export const VK_BOT_REVIEW_START = 'vk_review';
export const VK_BOT_REVIEW_CHANNEL_LIMIT = 5;
export const VK_BOT_REVIEW_USER_LIMIT = 10;

export const vkBotReviewSnapshotSchema = z.object({
  version: z.literal(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  payload: publishVkParsingPostRequestSchema,
  maxMessage: z.object({
    text: z.string().max(4000),
    textFormat: z.literal('html').optional(),
    engagementText: z.string(),
  }),
});
export type VkBotReviewSnapshot = z.infer<typeof vkBotReviewSnapshotSchema>;

export function buildVkBotReviewFingerprint(
  post: {
    contentHash: string;
    text: string;
    textFormat: string;
    photoUrls: unknown;
    videoUrls: unknown;
    linkUrls: unknown;
    isAdvertising: boolean;
    manualContentEditedAt: Date | null;
  },
  settings: {
    stripLinksEnabled: boolean;
    skipAdsEnabled: boolean;
    appendChannelLinkEnabled: boolean;
    channelLinkText: string;
    sourceLinkEnabled?: boolean;
    sourceLinkUrl?: string;
    deleteAfterMinutes?: number | null;
  },
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'vk-bot-review-v1',
        post.contentHash,
        post.text,
        post.textFormat,
        post.photoUrls,
        post.videoUrls,
        post.linkUrls,
        post.isAdvertising,
        post.manualContentEditedAt?.toISOString() ?? null,
        settings.stripLinksEnabled,
        settings.skipAdsEnabled,
        settings.appendChannelLinkEnabled,
        settings.channelLinkText,
        ...(settings.sourceLinkEnabled || settings.deleteAfterMinutes != null
          ? [
              settings.sourceLinkEnabled ?? false,
              settings.sourceLinkEnabled ? (settings.sourceLinkUrl ?? '') : '',
              settings.deleteAfterMinutes ?? null,
            ]
          : []),
      ]),
    )
    .digest('hex');
}

export type VkBotReviewAction = 'publish' | 'reject' | 'refresh' | 'menu' | 'pause' | 'resume';

export function parseVkBotReviewCallback(value: string): {
  action: VkBotReviewAction;
  id: string;
  revision: number;
} | null {
  const match =
    /^vkr:v1:(publish|reject|refresh|menu|pause|resume):([A-Za-z0-9_-]{1,160}):([1-9][0-9]{0,8})$/u.exec(
      value,
    );
  return match
    ? { action: match[1] as VkBotReviewAction, id: match[2]!, revision: Number(match[3]) }
    : null;
}

export function vkBotReviewCallback(action: VkBotReviewAction, id: string, revision = 1): string {
  return `${VK_BOT_REVIEW_CALLBACK_PREFIX}${action}:${id}:${revision}`;
}

export function isVkManualReviewMode(mode: string): boolean {
  return mode === 'REVIEW' || mode === VK_BOT_REVIEW_MODE;
}

export function isDefiniteVkReviewSendRejection(error: unknown): boolean {
  const parsed = z
    .object({
      response: z.object({
        status: z.number().int(),
        data: z.object({ code: z.string().trim().min(1).max(128) }),
      }),
    })
    .safeParse(error);
  return (
    parsed.success && [400, 401, 403, 404, 413, 422, 429].includes(parsed.data.response.status)
  );
}
