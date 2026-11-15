import type { DuplicateDeletionAttempt } from '@maxim/contracts/settings';

// FLAG: Count one latest result per message across overlapping history pages. An intent
// request, an absence receipt and a confirmed own deletion remain different outcomes.
export function summarizeDuplicateMessages(attempts: readonly DuplicateDeletionAttempt[]) {
  const messages = new Map<string, DuplicateDeletionAttempt>();
  for (const attempt of attempts) {
    const key = attempt.target ? `message:${attempt.target.messageId}` : `intent:${attempt.id}`;
    const previous = messages.get(key);
    if (!previous || Date.parse(attempt.updatedAt) > Date.parse(previous.updatedAt))
      messages.set(key, attempt);
  }
  const outcomes = new Map<DuplicateDeletionAttempt['outcome'], number>();
  for (const message of messages.values())
    outcomes.set(message.outcome, (outcomes.get(message.outcome) ?? 0) + 1);
  return { total: messages.size, outcomes: [...outcomes.entries()] };
}
