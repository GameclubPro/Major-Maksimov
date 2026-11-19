import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreviewState } from '../src/lib/api/preview-transport-state';
import { handleDialogPreviewRequest } from '../src/lib/api/preview-transport-dialog';
import {
  commentRestrictionLabel,
  describeCommentRestrictionError,
} from '../src/lib/comment-restriction';
import { createApiRequestError } from '../src/lib/api-request-error';
import { commentModerationKey } from '../src/lib/api/comment-moderation-client';
import type { CommentRestriction } from '@maxim/contracts/channel-dialog';

test('comment preview preserves scope, expiry and revisions through mute and release', () => {
  let now = new Date('2026-09-16T10:00:00Z');
  const state = createPreviewState({ clock: { now: () => now } });
  const token = 'preview-comments-token-0001';
  const base = '/chats/preview-chat/dialog/comments';
  const request = (path: string, method = 'GET', body?: unknown): any => {
    const url = new URL(path, 'https://preview.local');
    return handleDialogPreviewRequest({
      state,
      url,
      segments: url.pathname.split('/').filter(Boolean),
      method,
      init: body ? { body: JSON.stringify(body) } : {},
    });
  };
  const command = {
    token,
    action: 'MUTE',
    durationSeconds: 3600,
    reason: 'Спам',
    expectedRevision: 0,
    sourceMessageId: 'chat-comments-2',
  };
  const target = `${base}/moderation/users/preview-user-8`;
  const muted = request(target, 'PUT', command) as CommentRestriction;
  assert.equal(muted.kind, 'MUTE');
  assert.equal(muted.expiresAt, '2026-09-16T11:00:00.000Z');
  assert.throws(() => request(target, 'PUT', command), /уже изменилось/);
  state.me.userId = 'preview-user-8';
  assert.equal(request(`${base}/moderation?token=${token}`).canManage, false);
  assert.throws(() => request(`${base}/messages`, 'POST', { token, text: 'Обход' }), /ограничено/);
  assert.throws(
    () => request(`${base}/messages/chat-comments-2`, 'PATCH', { token, text: 'Обход' }),
    /ограничено/,
  );
  assert.throws(
    () => request(`${base}/messages/chat-comments-2/reactions`, 'POST', { token, emoji: 'like' }),
    /ограничено/,
  );
  assert.equal(
    request(`/chats/other/dialog/comments/moderation?token=${token}`).restriction.kind,
    null,
  );
  state.me.profile = 'publisher';
  assert.equal(request(`${base}/moderation?token=${token}`).restriction.kind, null);
  state.me.profile = 'moderation';
  now = new Date('2026-09-16T11:00:00Z');
  assert.equal(request(`${base}/moderation?token=${token}`).restriction.kind, null);
  assert.equal(request(`${base}/moderation?token=${token}`).restriction.revision, 1);
});

test('comment moderation labels and cache identities retain scope', () => {
  assert.equal(commentRestrictionLabel(undefined), 'Без ограничений');
  assert.equal(
    commentRestrictionLabel({ kind: 'BAN' } as CommentRestriction),
    'Бессрочная блокировка',
  );
  const context = {
    api: {} as never,
    profile: 'moderation' as const,
    entityType: 'chat' as const,
    chatId: 'chat',
    token: 'token',
  };
  assert.notDeepEqual(
    commentModerationKey(context),
    commentModerationKey({ ...context, profile: 'publisher' }),
  );
  assert.notDeepEqual(
    commentModerationKey(context),
    commentModerationKey({ ...context, entityType: 'channel' }),
  );
});

test('comment write feedback distinguishes temporary restrictions from unrelated permission errors', () => {
  const forbidden = 'Недостаточно прав для этого действия.';
  const restriction = {
    userId: 'user-1',
    displayName: null,
    kind: 'MUTE',
    expiresAt: '2026-09-16T11:00:00.000Z',
    reason: '',
    revision: 1,
  };
  assert.equal(
    describeCommentRestrictionError(
      createApiRequestError(
        403,
        JSON.stringify({ code: 'COMMENT_RESTRICTED', restriction }),
        forbidden,
      ),
    ),
    'Вам временно запрещено писать комментарии.',
  );
  assert.equal(
    describeCommentRestrictionError(
      createApiRequestError(403, JSON.stringify({ code: 'MINIAPP_PROFILE_FORBIDDEN' }), forbidden),
    ),
    null,
  );
});
