import type { ManagedEntityType } from '@maxim/contracts';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import { NIGHT_MODE_COMMENT_THREAD_PREFIX } from '../common/night-mode-comment-thread.util';
import { Prisma } from '../prisma/prisma-client';

export function buildDialogCommentThreadWhere(
  verifiedThreadId: string | null,
  entityType: ManagedEntityType,
  profile: MiniappProfile = 'moderation',
): Prisma.AuditLogWhereInput {
  if (verifiedThreadId) {
    return { payload: { path: ['threadId'], equals: verifiedThreadId } };
  }
  if (entityType !== 'chat' || profile !== 'moderation') return {};

  // FLAG: Old unscoped links retain ordinary legacy comments, but cannot read, reply to,
  // or mutate a night discussion without its own authenticated thread token.
  return {
    OR: [
      { payload: { path: ['threadId'], equals: Prisma.AnyNull } },
      {
        NOT: {
          payload: { path: ['threadId'], string_starts_with: NIGHT_MODE_COMMENT_THREAD_PREFIX },
        },
      },
    ],
  };
}
