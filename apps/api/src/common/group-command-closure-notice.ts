import { resolveEffectiveChatClosure } from '../moderation/night-mode-transition-time.util';
import type { Prisma } from '../prisma/prisma-client';
import type { GroupCommandPermit } from './group-command-authority.service';

export const MANUAL_OPEN_CHAT_NOTICE = 'Чат открыт. Для сообщений снова действуют обычные правила.';
const STILL_CLOSED_NOTICE = 'Ручное закрытие снято. Чат остаётся закрыт по ночному расписанию.';
export function manualOpenChatNotice(closed: boolean) {
  return closed ? STILL_CLOSED_NOTICE : MANUAL_OPEN_CHAT_NOTICE;
}

type ClosureRow = Parameters<typeof resolveEffectiveChatClosure>[0] & {
  orderAt: Date | null;
  orderKey: string | null;
  preparedAt: Date;
};

// FLAG: A saved command result proves what was applied, not whether the public notice
// is still true. One indexed SQL snapshot binds the original result to current settings.
export async function groupClosureNoticeDeadline(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  permit: GroupCommandPermit,
): Promise<number> {
  const result = permit.result;
  if (result?.action !== 'SILENCE' && result?.action !== 'OPEN_CHAT') return Infinity;
  if (!result.applied || !result.noticeText) return 0;
  const [row] = await db.$queryRaw<ClosureRow[]>`
    SELECT c.chat_control_order_at AS "orderAt", c.chat_control_order_key AS "orderKey",
           w.prepared_at AS "preparedAt", s.night_mode_enabled AS "nightModeEnabled",
           s.night_mode_start_time_minutes AS "nightModeStartTimeMinutes",
           s.night_mode_end_time_minutes AS "nightModeEndTimeMinutes", s.night_mode_timezone AS "nightModeTimezone",
           s.night_mode_force_close_enabled AS "nightModeForceCloseEnabled",
           s.night_mode_force_close_forever AS "nightModeForceCloseForever",
           s.night_mode_force_close_until AS "nightModeForceCloseUntil"
    FROM chats c JOIN chat_settings s ON s.chat_id = c.id
    JOIN webhook_execution_claims w ON w.id = ${permit.claimId}
    WHERE c.id = ${permit.chatId} AND c.entity_type = 'CHAT'
      AND w.kind = 'COMMAND' AND w.status = 'READY' AND w.enforced
      AND w.semantic_key = ${permit.semanticKey} AND w.webhook_event_id = ${permit.webhookEventId}
      AND w.lease_token = ${permit.leaseToken} AND w.command_result = ${JSON.stringify(result)}::jsonb
  `;
  if (!row?.preparedAt || !row.orderAt || !row.orderKey || row.orderAt < permit.sourceAt)
    throw new Error('Cannot establish original group control notice authority');
  if (row.orderAt.getTime() !== permit.sourceAt.getTime() || row.orderKey !== permit.semanticKey)
    return 0;
  const now = new Date();
  const current = resolveEffectiveChatClosure(row, now);
  if (result.action === 'SILENCE') {
    return current.manual.mode === 'timed' && current.manual.until
      ? Date.parse(current.manual.until)
      : 0;
  }
  if (current.manual.active || manualOpenChatNotice(current.closed) !== result.noticeText) return 0;
  // FLAG: Once the original interval ends, the same text becoming true again cannot
  // revive a pending notice. A continuously closed schedule has no daily boundary.
  const original = resolveEffectiveChatClosure(row, row.preparedAt);
  if (manualOpenChatNotice(original.closed) !== result.noticeText) return 0;
  return original.nextTransitionAt?.getTime() ?? Infinity;
}
