import { ConflictException } from '@nestjs/common';
import {
  dedupePrivateForwardedModerationTargets,
  extractForwardedModerationTargets,
} from './admin-forwarded-command.util';
import { trySendPrivateHandoff } from './private-control-handoff-send';
import type { MaxMessageButton } from '../max/max-client.service';
import { formatKaravanAllowlistChatTitle } from './private-control-karavan-allowlist-title';
import { escapePrivateMarkdown, privateMarkdownTitle } from './private-control-launcher-renderer';
import type { PendingKaravanAllowlistFlow, PrivateView } from './private-control.types';
import type { RedisCounterService } from './redis-counter.service';
import type { MaxUpdate } from '@maxim/contracts';

const PROMPT_DEDUP_SECONDS = 20;

export function karavanAllowlistPromptKey(flow: PendingKaravanAllowlistFlow): string {
  return `karavan-storefront-allowlist:prompt:${flow.nonce}:${flow.stage}`;
}

export async function prepareKaravanAllowlistLaunch<T>(
  redis: Pick<RedisCounterService, 'acquireLock' | 'releaseLock'> | undefined,
  sessionKey: string,
  prepare: () => Promise<T>,
): Promise<T> {
  if (!redis) return prepare();
  const key = `${sessionKey}:karavan-allowlist-launch`;
  const token = await redis.acquireLock(key, 30_000);
  if (!token)
    throw new ConflictException(
      'Добавление уже запускается. Нажмите ещё раз через несколько секунд.',
    );
  try {
    return await prepare();
  } finally {
    await redis.releaseLock(key, token).catch(() => undefined);
  }
}

export async function deliverKaravanAllowlistPrompt(params: {
  flow: PendingKaravanAllowlistFlow;
  redis: Pick<
    RedisCounterService,
    'getString' | 'setStringWithTtl' | 'deleteKey' | 'acquireLock' | 'releaseLock'
  >;
  send: () => Promise<unknown>;
  onFailure: (error: unknown) => void;
}): Promise<void> {
  const { flow, redis, send, onFailure } = params;
  const key = karavanAllowlistPromptKey(flow);
  const lockKey = `${key}:send`;
  const token = await redis.acquireLock(lockKey, 15_000);
  if (!token) return;
  try {
    const receipt = await redis.getString(key);
    if (receipt) return;
    // FLAG: Persist the in-flight state before MAX. A crashed or unconfirmed send
    // must not be retried by the other entry point.
    await redis.setStringWithTtl(
      key,
      'unknown',
      Math.max(1, Math.ceil((flow.expiresAt - Date.now()) / 1000)),
    );
    const result = await trySendPrivateHandoff(send, onFailure);
    if (result.outcome === 'sent') {
      await redis.setStringWithTtl(key, 'sent', PROMPT_DEDUP_SECONDS);
    } else {
      await redis.deleteKey(key);
    }
  } finally {
    await redis.releaseLock(lockKey, token).catch(() => undefined);
  }
}

export function readKaravanAllowlistForwardedTargets(update: MaxUpdate) {
  return dedupePrivateForwardedModerationTargets(
    extractForwardedModerationTargets(update, null, {
      messageNodeMode: 'incoming-message',
      readPrivateForwardedFields: true,
    }),
  );
}

export function renderKaravanAllowlistDurationPrompt(
  flow: PendingKaravanAllowlistFlow,
  button: (
    label: string,
    duration: string | null,
    intent?: 'positive' | 'negative',
  ) => MaxMessageButton,
): PrivateView {
  const label = flow.targetDisplayName?.trim() || 'Пользователь';
  const chatTitle = formatKaravanAllowlistChatTitle(flow.chatId, flow.chatTitle);
  return {
    text: [
      privateMarkdownTitle('Срок разрешения'),
      '',
      `Пользователь: ${escapePrivateMarkdown(label)}`,
      `Чат: ${escapePrivateMarkdown(chatTitle)}`,
      '',
      'Выберите срок публикации витрин:',
    ].join('\n'),
    options: {
      buttons: [
        [button('1 день', '1d'), button('7 дней', '7d')],
        [button('30 дней', '30d'), button('90 дней', '90d')],
        [button('Бессрочно', 'forever', 'positive')],
        [button('Отмена', null, 'negative')],
      ],
    },
  };
}
