import type { Logger } from '@nestjs/common';
import type { MaxChatAdminRosterSyncService } from '../max/max-chat-admin-roster-sync.service';
import { DESTRUCTIVE_ADMIN_ROSTER_REFRESH_THROTTLE_MS } from './moderation.service.support';

export type ModerationAdminRosterRefresh = {
  chatId: string;
  chatTitle: string | undefined;
  botId: string | null;
  entityType: string | null;
  stage: string;
};

export function scheduleModerationAdminRosterRefresh(
  host: {
    rosters?: Pick<
      MaxChatAdminRosterSyncService,
      'observeActivity' | 'scheduleChatAdminRosterSync'
    >;
    scheduledAt: Map<string, number>;
    logger: Pick<Logger, 'warn'>;
  },
  params: ModerationAdminRosterRefresh,
): void {
  if (typeof host.rosters?.observeActivity === 'function') {
    void host.rosters.observeActivity(params.chatId, params.botId).catch(() => undefined);
    return;
  }
  if (typeof host.rosters?.scheduleChatAdminRosterSync !== 'function') return;
  const chatId = params.chatId.trim();
  if (!chatId) return;
  const now = Date.now();
  if (now - (host.scheduledAt.get(chatId) ?? 0) < DESTRUCTIVE_ADMIN_ROSTER_REFRESH_THROTTLE_MS)
    return;
  host.scheduledAt.set(chatId, now);
  void host.rosters
    .scheduleChatAdminRosterSync({
      chatId,
      botIds: params.botId ? [params.botId] : [],
      title: params.chatTitle ?? null,
      entityType: params.entityType === 'channel' ? 'channel' : 'chat',
      source: 'moderation_destructive_path',
      retryUntilMs: null,
    })
    .catch((error: unknown) => {
      host.scheduledAt.delete(chatId);
      host.logger.warn(
        {
          chatId,
          stage: params.stage,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to schedule destructive moderation admin roster refresh',
      );
    });
}
