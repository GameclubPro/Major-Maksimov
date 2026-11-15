import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DuplicateDeletionAttempt } from '@maxim/contracts/settings';
import { summarizeDuplicateMessages } from '../src/pages/settings/duplicate-diagnostics-summary';

const row = (
  id: string,
  outcome: DuplicateDeletionAttempt['outcome'],
  updatedAt = '2026-11-15T10:00:00Z',
): DuplicateDeletionAttempt => ({
  id,
  outcome,
  updatedAt,
  createdAt: '2026-11-15T09:00:00Z',
  reason: null,
  nextAttemptAt: null,
  target: { messageId: id, publishedAt: null },
});

describe('duplicate result summary', () => {
  it('counts the latest message result once across overlapping pages and distinguishes absence', () => {
    const pending = row('one', 'PENDING');
    const deleted = row('one', 'DELETED', '2026-11-15T10:01:00Z');
    const absent = row('two', 'ALREADY_ABSENT');
    assert.deepEqual(summarizeDuplicateMessages([deleted, pending, absent, deleted]), {
      total: 2,
      outcomes: [
        ['DELETED', 1],
        ['ALREADY_ABSENT', 1],
      ],
    });
  });
  it('preserves unknown outcomes and uses intent identity for older responses', () => {
    const unconfirmed = row('one', 'UNCONFIRMED');
    delete unconfirmed.target;
    assert.deepEqual(summarizeDuplicateMessages([unconfirmed, unconfirmed]), {
      total: 1,
      outcomes: [['UNCONFIRMED', 1]],
    });
    assert.deepEqual(summarizeDuplicateMessages([]), { total: 0, outcomes: [] });
  });
});
