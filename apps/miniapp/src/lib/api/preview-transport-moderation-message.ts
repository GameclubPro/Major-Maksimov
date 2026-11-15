import { moderationMessageDetailsSchema } from '@maxim/contracts';
import {
  PREVIEW_NOT_HANDLED,
  resolvePreviewEntityRequest,
  type PreviewRequestHandler,
} from './preview-transport-runtime';

export const handleModerationMessagePreviewRequest: PreviewRequestHandler = (context) => {
  const entity = resolvePreviewEntityRequest(context);
  if (!entity || entity.entityType !== 'chat' || context.method !== 'GET')
    return PREVIEW_NOT_HANDLED;
  const { tail } = entity;
  if (tail.length !== 3 || tail[0] !== 'moderation-feed' || tail[2] !== 'message')
    return PREVIEW_NOT_HANDLED;
  const item = context.state.chatViolations.find(
    (entry) => entry.id === decodeURIComponent(tail[1]!),
  );
  if (!item) throw new Error('Запись не найдена.');
  return moderationMessageDetailsSchema.parse({
    eventId: item.id,
    state: item.maskedExcerpt ? 'partial' : 'not_captured',
    content: item.maskedExcerpt
      ? { text: item.maskedExcerpt, truncated: true, attachments: [] }
      : null,
    sourceAt: null,
    expiresAt: null,
  });
};
