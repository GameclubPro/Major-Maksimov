import { moderationMessageDetailsSchema } from '@maxim/contracts';
import type { ApiTransport } from './transport';

export async function getModerationMessage(
  api: ApiTransport,
  chatId: string,
  eventId: string,
  signal: AbortSignal,
) {
  const result = moderationMessageDetailsSchema.parse(
    await api.request(
      `/chats/${encodeURIComponent(chatId)}/moderation-feed/${encodeURIComponent(eventId)}/message`,
      { signal, cache: 'no-store' },
    ),
  );
  if (result.eventId !== eventId) throw new Error('Не удалось загрузить сообщение.');
  return result;
}
