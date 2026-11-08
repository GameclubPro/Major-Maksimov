export const NIGHT_MODE_COMMENT_THREAD_PREFIX = 'night-close-v1:';

const NIGHT_MODE_COMMENT_THREAD_PATTERN =
  /^night-close-v1:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

// FLAG: Apply this scope only after the dialog token authenticates the exact chat and thread.
// Ordinary legacy threads must never gain access merely because night comments are enabled.
export function isNightModeCommentThreadId(threadId: string | null | undefined): boolean {
  return typeof threadId === 'string' && NIGHT_MODE_COMMENT_THREAD_PATTERN.test(threadId);
}
