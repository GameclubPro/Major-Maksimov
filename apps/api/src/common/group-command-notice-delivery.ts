import type { ChatSettings } from '../prisma/prisma-client';
import { createHash } from 'node:crypto';
import { withMaxFinalAuthorityCheckpoint } from '../max/max-action-pre-dispatch-guard';
import { prepareFormattedTextForMaxDelivery } from './max-markdown.util';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  normalizeMaxActionIdempotencyKeyPart,
} from '../max/max-client.service';
import {
  GroupCommandAuthorityService,
  GroupCommandNoticeDeliveryError,
  type GroupCommandPermit,
} from './group-command-authority.service';

export function groupCommandNoticeIdempotencyKey(semanticKey: string): string {
  return `group-command-notice:${semanticKey}`;
}

export function groupCommandNoticeLedgerKey(semanticKey: string): string {
  const parts = ['explicit', 'SEND_MESSAGE', groupCommandNoticeIdempotencyKey(semanticKey)];
  const digest = createHash('sha256').update(parts.join('\u001f')).digest('base64url').slice(0, 24);
  const readable = parts
    .map(normalizeMaxActionIdempotencyKeyPart)
    .filter(Boolean)
    .join('__')
    .slice(0, 160)
    .replace(/_+$/u, '');
  return `max-action__${readable}__${digest}`;
}

export async function deliverGroupCommandNotice(params: {
  max: MaxClientService;
  authority: GroupCommandAuthorityService;
  permit: GroupCommandPermit;
  settings: Pick<ChatSettings, 'deleteBotMessagesEnabled' | 'deleteBotMessagesDelayMinutes'>;
  text?: string;
  beforeMutation?: () => Promise<void | Date>;
}): Promise<void> {
  const { max, authority, permit, settings } = params;
  if (!permit.result) {
    const result = { action: 'NOTICE', noticeText: params.text ?? null, applied: false };
    await authority.prepareResult(permit, result);
    permit.result = result;
  }
  if (!permit.result.noticeText) return;
  try {
    await authority.assertOwned(permit);
    const prepared = prepareFormattedTextForMaxDelivery(permit.result.noticeText, 'markdown');
    if (!prepared) throw new Error('Group command notice exceeds MAX text limit');
    // FLAG: A saved command notice retains one logical SEND key and its original bot.
    // The final transport guard renews both authority leases on narrow recovery.
    await max.sendMessage(
      permit.chatId,
      prepared.text,
      { textFormat: prepared.textFormat },
      {
        immediate: true,
        botId: permit.executionBotId,
        candidateBotIds: [permit.executionBotId],
        routing: { purpose: 'send_message', requiredBotId: permit.executionBotId },
        beforeImmediateSendMutation: withMaxFinalAuthorityCheckpoint(async (revalidateRoute) => {
          await authority.assertFreshHeldCommandAccess(permit, max);
          await revalidateRoute?.();
          // FLAG: Transport admission may outlive either SQL lease or the saved source.
          // Recheck command and recovery ownership after its wait, before the final deadline.
          await authority.assertOwned(permit);
          const recoveryLeaseUntil = await params.beforeMutation?.();
          const noticeDeadline = await authority.closureNoticeDeadline(permit);
          // FLAG: No awaited proof may consume the command lease or source deadline
          // between its check and the actual HTTP mutation boundary.
          const now = Date.now();
          if (now >= noticeDeadline)
            throw new Error('Saved group closure notice is no longer current');
          if (
            (recoveryLeaseUntil instanceof Date && recoveryLeaseUntil.getTime() <= now) ||
            (permit.leaseExpiresAt && permit.leaseExpiresAt.getTime() <= now) ||
            (permit.executionDeadlineAt !== undefined &&
              (!permit.executionDeadlineAt || permit.executionDeadlineAt.getTime() <= now))
          )
            throw new Error('Group command notice authority expired before transport');
        }),
        idempotencyKey: groupCommandNoticeIdempotencyKey(permit.semanticKey),
        ledgerContext: { moderationNoticeEnvelope: { version: 1 } },
        ...(settings.deleteBotMessagesEnabled
          ? { autoDeleteDelayMs: settings.deleteBotMessagesDelayMinutes * 60_000 }
          : {}),
        trafficClass: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.MODERATION_NOTICE,
      },
    );
  } catch (error: unknown) {
    throw new GroupCommandNoticeDeliveryError(error);
  }
}
