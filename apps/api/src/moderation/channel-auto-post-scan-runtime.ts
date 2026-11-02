import type { MaxClientService, MaxSendMessageOptions } from '../max/max-client.service';
import type { PrismaService } from '../prisma/prisma.service';
import { loadChannelAutoPostScanContexts } from './channel-auto-post-context';
import type { ChannelAutoPostLegacyRecovery } from './channel-auto-post-legacy-recovery';
import type {
  ChannelAutoPostAttachOutcome,
  ChannelAutoPostMessageText,
  ChannelAutoPostScanManager,
} from './channel-auto-post-runtime';
import { runChannelAutoPostScanBatch } from './channel-auto-post-scan-batch';
import { channelDecorationStart } from './channel-marketplace-decoration';
import type { ChannelPostDemandRuntime } from './channel-post-demand-runtime';
import type {
  ChannelAutoPostExecutionPlan,
  ManagedChannelContext,
} from './moderation.service.support';

export interface ChannelAutoPostAttachParams {
  chatId: string;
  messageId: string;
  text: string | null;
  textFormat?: MaxSendMessageOptions['textFormat'] | null;
  quickButtons?: ChannelAutoPostMessageText['quickButtons'];
  linkType: string | null;
  existingDialogButtonKinds?: readonly ('comments' | 'suggest')[];
  existingDialogThreadId?: string | null;
  managedChannel: ManagedChannelContext;
  source: 'webhook' | 'poll';
  schedulingOrigin?: 'durable_demand' | 'periodic_scan';
  senderId: string | null;
  senderAdminVerified: boolean;
  allowSenderlessEngagement: boolean;
  sourceMessageAt?: string | null;
  marketplaceAt?: Date | null;
}

type ScanBatchInput = Parameters<typeof runChannelAutoPostScanBatch>[0];
type MarketplaceScanClient = Partial<
  Pick<
    MaxClientService,
    'listMarketplaceChannelPostTargets' | 'getMarketplaceChannelPostActivation'
  >
>;

const CHANNEL_SCAN_CANDIDATE_PAGE_SIZE = 64;

export class ChannelAutoPostScanRuntime {
  private channelScanCursor: string | undefined;
  private marketplaceChannelScanCursor: string | undefined;
  private pendingChannelCandidates: Array<{ chatId: string }> = [];
  private pendingMarketplaceCandidates: Array<{ chatId: string }> = [];
  private preferMarketplace = false;

  async run(
    input: Pick<
      ScanBatchInput,
      | 'manager'
      | 'processChannel'
      | 'sleep'
      | 'isTransientLookupError'
      | 'onGlobalBackoff'
      | 'onFailure'
    > & {
      prisma: PrismaService;
      maxClient: MarketplaceScanClient;
      plan: ChannelAutoPostExecutionPlan;
      demand: Pick<ChannelPostDemandRuntime, 'selectChannels' | 'process'>;
      recovery: Pick<ChannelAutoPostLegacyRecovery, 'runIfDue'>;
      scanIntervalMs: number;
      rateLimitBackoffMs: number;
    },
  ): Promise<void> {
    if (this.pendingChannelCandidates.length === 0) {
      // FLAG: Page the unique chat key before filtering settings so disabled rows
      // do not have to be traversed to fill an enabled-only candidate page.
      const page = await input.prisma.channelSettings.findMany({
        ...(this.channelScanCursor ? { where: { chatId: { gt: this.channelScanCursor } } } : {}),
        select: {
          chatId: true,
          quickButtonsEnabled: true,
          postSignatureEnabled: true,
          commentsEnabled: true,
          postSuggestionsEnabled: true,
        },
        orderBy: { chatId: 'asc' },
        take: CHANNEL_SCAN_CANDIDATE_PAGE_SIZE,
      });
      this.channelScanCursor =
        page.length === CHANNEL_SCAN_CANDIDATE_PAGE_SIZE ? page.at(-1)!.chatId : undefined;
      this.pendingChannelCandidates = page
        .filter(
          (item) =>
            item.quickButtonsEnabled ||
            item.postSignatureEnabled ||
            item.commentsEnabled ||
            item.postSuggestionsEnabled,
        )
        .map(({ chatId }) => ({ chatId }));
    }
    if (this.pendingMarketplaceCandidates.length === 0) {
      const marketplaceChannels =
        (await input.maxClient.listMarketplaceChannelPostTargets?.(
          Math.max(1, Math.min(CHANNEL_SCAN_CANDIDATE_PAGE_SIZE, input.plan.batchSize)),
          this.marketplaceChannelScanCursor,
        )) ?? [];
      this.marketplaceChannelScanCursor = marketplaceChannels.length
        ? marketplaceChannels.at(-1)!.chatId
        : undefined;
      this.pendingMarketplaceCandidates = marketplaceChannels.map(({ chatId }) => ({ chatId }));
    }
    const demandRefs = await input.demand.selectChannels(
      input.plan.batchSize,
      input.scanIntervalMs,
    );
    const demandedIds = new Set(demandRefs.map((item) => item.chatId));
    const fallbackBudget = Math.max(0, input.plan.batchSize - demandRefs.length);
    const available = (item: { chatId: string }) =>
      !demandedIds.has(item.chatId) && input.manager.isDue(item.chatId);
    this.pendingChannelCandidates = this.pendingChannelCandidates.filter(available);
    this.pendingMarketplaceCandidates = this.pendingMarketplaceCandidates.filter(available);
    let channelCandidates = [...this.pendingChannelCandidates];
    let marketplaceCandidates = [...this.pendingMarketplaceCandidates];
    const fallbackRefs: Array<{ chatId: string }> = [];
    // FLAG: Retain due candidates that did not fit and alternate sources even
    // with a single slot, so neither regular nor marketplace pages can starve.
    while (
      fallbackRefs.length < fallbackBudget &&
      (channelCandidates.length > 0 || marketplaceCandidates.length > 0)
    ) {
      const useMarketplace =
        marketplaceCandidates.length > 0 &&
        (this.preferMarketplace || channelCandidates.length === 0);
      const candidates = useMarketplace ? marketplaceCandidates : channelCandidates;
      const [selected] = input.manager.selectBatch(candidates, 1);
      if (!selected) break;
      fallbackRefs.push(selected);
      channelCandidates = channelCandidates.filter((item) => item.chatId !== selected.chatId);
      marketplaceCandidates = marketplaceCandidates.filter(
        (item) => item.chatId !== selected.chatId,
      );
      this.preferMarketplace = !useMarketplace;
    }
    const scanBatchRefs = [
      ...demandRefs.filter((item) => input.manager.isDemandDue(item.chatId)),
      ...fallbackRefs,
    ];
    const scanBatch = await loadChannelAutoPostScanContexts(
      input.prisma,
      scanBatchRefs.map((item) => item.chatId),
    );

    const hydratedIds = new Set(scanBatch.map((channel) => channel.channelSettings.chatId));
    const attemptedFallbackIds = new Set<string>();
    let encounteredTransientThrottle: boolean;
    try {
      encounteredTransientThrottle = await runChannelAutoPostScanBatch({
        channels: scanBatch,
        plan: input.plan,
        manager: input.manager,
        processChannel: (channel, options) => {
          const chatId = channel.channelSettings.chatId;
          if (demandedIds.has(chatId))
            return input.demand.process(
              channel,
              options.maxNewMessagesPerScan,
              input.scanIntervalMs,
            );
          attemptedFallbackIds.add(chatId);
          return input.processChannel(channel, options);
        },
        sleep: input.sleep,
        isTransientLookupError: input.isTransientLookupError,
        onGlobalBackoff: input.onGlobalBackoff,
        onFailure: input.onFailure,
      });
    } finally {
      const retiredIds = new Set(
        fallbackRefs
          .filter((item) => !hydratedIds.has(item.chatId) || attemptedFallbackIds.has(item.chatId))
          .map((item) => item.chatId),
      );
      this.pendingChannelCandidates = this.pendingChannelCandidates.filter(
        (item) => !retiredIds.has(item.chatId),
      );
      this.pendingMarketplaceCandidates = this.pendingMarketplaceCandidates.filter(
        (item) => !retiredIds.has(item.chatId),
      );
    }

    if (!encounteredTransientThrottle) {
      const recovery = await input.recovery.runIfDue();
      if (recovery.stopCurrentTick) {
        input.onGlobalBackoff(input.rateLimitBackoffMs);
      }
      input.manager.resetThrottle();
    }
  }
}

export async function processChannelAutoPostListedMessages(input: {
  managedChannel: ManagedChannelContext;
  messages: Awaited<ReturnType<MaxClientService['listMessages']>>;
  maxNewMessagesPerScan: number;
  maxClient: MarketplaceScanClient;
  manager: ChannelAutoPostScanManager;
  attach: (params: ChannelAutoPostAttachParams) => Promise<ChannelAutoPostAttachOutcome>;
}): Promise<void> {
  const { managedChannel, messages, maxNewMessagesPerScan } = input;
  const chatId = managedChannel.channelSettings.chatId;
  const marketplaceAt =
    (await input.maxClient.getMarketplaceChannelPostActivation?.(chatId)) ?? null;
  const enabledFrom = channelDecorationStart(managedChannel.channelSettings, marketplaceAt);
  if (enabledFrom === null) return;
  await input.manager.processListedMessages({
    chatId,
    messages,
    adminUserIds: managedChannel.adminUserIds,
    settingsUpdatedAtMs: enabledFrom,
    maxNewMessagesPerScan,
    quickButtonsEnabled: managedChannel.channelSettings.quickButtonsEnabled === true,
    attach: (normalized) =>
      input.attach({
        chatId,
        messageId: normalized.messageId,
        text: normalized.text,
        textFormat: normalized.textFormat,
        quickButtons: normalized.quickButtons,
        linkType: normalized.linkType,
        existingDialogButtonKinds: normalized.existingDialogButtonKinds,
        existingDialogThreadId: normalized.existingDialogThreadId,
        managedChannel,
        source: 'poll',
        schedulingOrigin: 'periodic_scan',
        sourceMessageAt: new Date(normalized.timestampMs).toISOString(),
        senderId: normalized.senderId,
        senderAdminVerified:
          normalized.senderId !== null && managedChannel.adminUserIds.includes(normalized.senderId),
        allowSenderlessEngagement: true,
      }),
  });
}
