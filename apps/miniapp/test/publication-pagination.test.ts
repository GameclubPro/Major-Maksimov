import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isAmbiguousDeliveryPhaseComplete,
  mergeLegacyPublicationPages,
  mergePrioritizedPublicationPages,
  mergePublicationDeliveryPages,
  mergePublicationPages,
  shouldPollPublicationDeliveryPages,
} from '../src/features/publications/publication-pagination';

test('legacy publication pagination keeps colliding ids from different stores', () => {
  assert.deepEqual(
    mergeLegacyPublicationPages([
      {
        items: [
          { id: 'same-id', kind: 'autopost', value: 1 },
          { id: 'same-id', kind: 'broadcast', value: 2 },
        ],
      },
      { items: [{ id: 'same-id', kind: 'autopost', value: 3 }] },
    ]),
    [
      { id: 'same-id', kind: 'autopost', value: 3 },
      { id: 'same-id', kind: 'broadcast', value: 2 },
    ],
  );
});

test('keeps general deliveries blocked after the first ambiguous page fails', () => {
  assert.equal(
    isAmbiguousDeliveryPhaseComplete({
      hasAmbiguous: true,
      hasData: false,
      hasNextPage: false,
      isError: true,
      isFetchingNextPage: false,
      isSuccess: false,
    }),
    false,
  );
  assert.equal(
    isAmbiguousDeliveryPhaseComplete({
      hasAmbiguous: true,
      hasData: true,
      hasNextPage: true,
      isError: true,
      isFetchingNextPage: false,
      isSuccess: false,
    }),
    true,
  );
});

test('merges publication cursor pages without duplicate cards', () => {
  const items = mergePublicationPages([
    {
      items: [
        { id: 'publication-1', version: 1 },
        { id: 'publication-2', version: 1 },
      ],
    },
    {
      items: [
        { id: 'publication-2', version: 2 },
        { id: 'publication-3', version: 1 },
      ],
    },
  ]);

  assert.deepEqual(items, [
    { id: 'publication-1', version: 1 },
    { id: 'publication-2', version: 2 },
    { id: 'publication-3', version: 1 },
  ]);
});

test('keeps ambiguous deliveries first while deduplicating the general feed', () => {
  const items = mergePrioritizedPublicationPages(
    [
      { items: [{ id: 'delivery-ambiguous-1', status: 'AMBIGUOUS' }] },
      { items: [{ id: 'delivery-ambiguous-2', status: 'AMBIGUOUS' }] },
    ],
    [
      {
        items: [
          { id: 'delivery-sent', status: 'SENT' },
          { id: 'delivery-ambiguous-1', status: 'AMBIGUOUS' },
        ],
      },
    ],
  );

  assert.deepEqual(items, [
    { id: 'delivery-ambiguous-1', status: 'AMBIGUOUS' },
    { id: 'delivery-ambiguous-2', status: 'AMBIGUOUS' },
    { id: 'delivery-sent', status: 'SENT' },
  ]);
});

test('does not reuse the old priority page when the all-history review count reaches zero', () => {
  const items = mergePublicationDeliveryPages(
    false,
    [{ items: [{ id: 'delivery-stale-priority', status: 'AMBIGUOUS' }] }],
    [
      {
        items: [{ id: 'delivery-sent', status: 'SENT' }],
      },
    ],
  );

  assert.deepEqual(items, [{ id: 'delivery-sent', status: 'SENT' }]);
});

test('keeps a fresh ambiguous general row even while its aggregate count is stale', () => {
  assert.deepEqual(
    mergePublicationDeliveryPages(false, undefined, [
      {
        items: [
          { id: 'delivery-unknown', status: 'AMBIGUOUS' },
          { id: 'delivery-sent', status: 'SENT' },
        ],
      },
    ]),
    [
      { id: 'delivery-unknown', status: 'AMBIGUOUS' },
      { id: 'delivery-sent', status: 'SENT' },
    ],
  );
});

test('keeps polling cached delivery rows until their terminal state is fetched', () => {
  assert.equal(
    shouldPollPublicationDeliveryPages(false, [
      {
        items: [{ status: 'SENT' }, { status: 'PENDING' }],
      },
    ]),
    true,
  );
  assert.equal(
    shouldPollPublicationDeliveryPages(false, [
      {
        items: [{ status: 'SENT' }, { status: 'FAILED' }],
      },
    ]),
    false,
  );
  assert.equal(shouldPollPublicationDeliveryPages(true, undefined), true);
});

test('stopped cached attempts stop dispatch polling without hiding active or unknown siblings', () => {
  const stopped = [
    { status: 'PENDING', dispatchStopped: true },
    { status: 'SENDING', dispatchStopped: true },
    { status: 'AMBIGUOUS', dispatchStopped: true },
  ];
  assert.equal(shouldPollPublicationDeliveryPages(false, [{ items: stopped }]), false);
  assert.equal(shouldPollPublicationDeliveryPages(true, [{ items: stopped }]), true);
  for (const dispatchStopped of [false, undefined]) {
    for (const status of ['PENDING', 'SENDING']) {
      assert.equal(
        shouldPollPublicationDeliveryPages(false, [
          { items: [...stopped, { status, dispatchStopped }] },
        ]),
        true,
      );
    }
  }
});
