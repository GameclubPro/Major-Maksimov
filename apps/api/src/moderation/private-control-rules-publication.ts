import { BadRequestException } from '@nestjs/common';
import type { ChatRules, PublishChatRulesResult } from '@maxim/contracts';
import type { AuthUser } from '../common/decorators/current-user.decorator';

export async function publishPrivateRules(
  publisher: {
    publishRules: (
      chatId: string,
      actor: AuthUser,
      source: 'private_bot',
      mode: 'new_message',
    ) => Promise<PublishChatRulesResult>;
  },
  chatId: string,
  actor: AuthUser,
) {
  const result = await publisher.publishRules(chatId, actor, 'private_bot', 'new_message');
  if (!result?.messageId?.trim()) {
    throw new BadRequestException('Не удалось подтвердить публикацию правил.');
  }
  const updated = result.operation === 'updated';
  return {
    text: updated
      ? '✅ Правила обновлены в прежнем сообщении. Новое сообщение в группу не отправлялось.'
      : '✅ Правила опубликованы новым сообщением.',
    notification: updated ? '✅ Правила обновлены' : '✅ Правила опубликованы',
  };
}

export async function resetPrivateRules(
  publisher: {
    resetPublishedRules: (
      chatId: string,
      actor: AuthUser,
      source: 'private_bot',
    ) => Promise<ChatRules>;
  },
  chatId: string,
  actor: AuthUser,
) {
  const result = await publisher.resetPublishedRules(chatId, actor, 'private_bot');
  if (!result) {
    throw new BadRequestException('Не удалось подтвердить удаление правил.');
  }
  // FLAG: A retained receipt, including a URL without an ID, cannot confirm a reset.
  // It can represent pending deletion or a newer publication; preserve that distinction.
  const stillPublished = Boolean(result.publishedMessageId || result.publishedUrl);
  return {
    text: stillPublished
      ? 'Пост правил пока опубликован. Проверьте его в мини-приложении.'
      : 'Публикация правил сброшена.',
    notification: stillPublished ? 'Проверьте публикацию' : 'Публикация сброшена',
  };
}
