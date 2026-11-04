import { MaxApiInternalRateLimitError } from '../max/max-client.service';
import { isChannelAutoPostScopedWait } from './channel-auto-post-error-scope';
import type { ChannelAutoPostScanManager } from './channel-auto-post-runtime';
import type { ManagedChannelContext } from './moderation.service.support';

export async function runChannelAutoPostScanBatch(input: {
  channels: readonly ManagedChannelContext[];
  plan: { interChannelDelayMs: number; maxNewMessagesPerScan: number };
  manager: ChannelAutoPostScanManager;
  processChannel: (
    channel: ManagedChannelContext,
    options: { maxNewMessagesPerScan: number },
  ) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  onFailure: (chatId: string, error: unknown) => void;
  isTransientLookupError: (error: unknown) => boolean;
  onGlobalBackoff: (ms: number) => void;
}): Promise<boolean> {
  for (const [index, channel] of input.channels.entries()) {
    if (index > 0) await input.sleep(input.plan.interChannelDelayMs);
    const chatId = channel.channelSettings.chatId;
    try {
      await input.processChannel(channel, {
        maxNewMessagesPerScan: input.plan.maxNewMessagesPerScan,
      });
      input.manager.resetScopedThrottle(chatId);
    } catch (error: unknown) {
      input.onFailure(chatId, error);
      // FLAG: Keep the existing bounded pass and shared MAX admission. A scoped wait
      // does not authorize another attempt on this post or waive a mutation fence.
      if (isChannelAutoPostScopedWait(error)) {
        input.manager.recordTransientThrottle(chatId, true, error.retryAfterMs);
        continue;
      }
      if (error instanceof MaxApiInternalRateLimitError || input.isTransientLookupError(error)) {
        input.onGlobalBackoff(
          input.manager.recordTransientThrottle(
            chatId,
            false,
            error instanceof MaxApiInternalRateLimitError ? error.retryAfterMs : 0,
          ),
        );
        return true;
      }
      // FLAG: An unknown channel failure postpones this source without changing
      // access evidence, message progress or independent channels' admission.
      input.manager.recordTransientThrottle(chatId, true);
    }
  }
  return false;
}
