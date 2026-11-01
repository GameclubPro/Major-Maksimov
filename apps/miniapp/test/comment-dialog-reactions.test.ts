import assert from 'node:assert/strict';
import test from 'node:test';
import {
  channelDialogResponseSchema,
  type ChannelDialogMessage,
  type ChannelDialogReactionGroup,
  type ChannelDialogResponse,
} from '@maxim/contracts/channel-dialog';
import { toggleDialogReactionLocally } from '../src/lib/comment-dialog-reactions';

function reaction(emoji: string, count: number, reactedByMe = false): ChannelDialogReactionGroup {
  return { emoji, count, reactedByMe };
}

function message(id: string, reactionGroups: ChannelDialogReactionGroup[]): ChannelDialogMessage {
  return {
    id,
    type: 'comments',
    text: `Comment ${id}`,
    authorUserId: 'comment-author',
    authorDisplayName: 'Comment author',
    isAdmin: true,
    avatarUrl: 'https://example.com/avatar.png',
    createdAt: '2026-11-01T00:00:00.000Z',
    editedAt: null,
    replyToMessageId: 'parent-message',
    replyTo: {
      messageId: 'parent-message',
      authorDisplayName: 'Parent author',
      text: 'Parent comment',
    },
    attachments: [
      {
        kind: 'image',
        url: 'https://example.com/image.png',
        previewUrl: 'https://example.com/preview.png',
        fileName: 'image.png',
        mimeType: 'image/png',
        size: 128,
      },
    ],
    reactionGroups,
    canEdit: true,
    canDelete: true,
    canDeleteAsAdmin: false,
  };
}

function dialog(messages: ChannelDialogMessage[]): ChannelDialogResponse {
  const fixture: ChannelDialogResponse = {
    chatId: 'comment-chat',
    type: 'comments',
    introText: 'Comment thread',
    messages,
    hasMoreMessages: true,
    notificationSettings: {
      mode: 'replies',
      canUseAll: true,
      scope: 'thread',
      thread: { mode: 'replies', explicit: true },
      channel: { mode: 'off', explicit: false },
      allChannels: { mode: 'off', explicit: false },
    },
  };
  return channelDialogResponseSchema.parse(fixture);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      freeze(nested);
    }
  }
  return value;
}

test('an absent dialog remains absent', () => {
  assert.equal(toggleDialogReactionLocally(undefined, 'target', 'b'), undefined);
});

test('an empty dialog keeps its values and metadata while cloning its containers', () => {
  const input = freeze(dialog([]));
  const output = toggleDialogReactionLocally(input, 'target', 'b');

  assert.ok(output);
  assert.deepEqual(output, input);
  assert.notEqual(output, input);
  assert.notEqual(output.messages, input.messages);
  assert.equal(output.notificationSettings, input.notificationSettings);
});

test('a missing message preserves every message reference while cloning dialog containers', () => {
  const input = freeze(dialog([message('other', [reaction('a', 2)])]));
  const output = toggleDialogReactionLocally(input, 'target', 'b');

  assert.ok(output);
  assert.deepEqual(output, input);
  assert.notEqual(output, input);
  assert.notEqual(output.messages, input.messages);
  assert.equal(output.messages[0], input.messages[0]);
  assert.equal(output.messages[0]?.reactionGroups, input.messages[0]?.reactionGroups);
  assert.equal(output.notificationSettings, input.notificationSettings);
});

const singleToggles: Array<{
  name: string;
  input: ChannelDialogReactionGroup[];
  emoji: string;
  expected: ChannelDialogReactionGroup[];
}> = [
  {
    name: 'creates the first reaction',
    input: [],
    emoji: 'b',
    expected: [reaction('b', 1, true)],
  },
  {
    name: 'increments an existing reaction and sorts equal counts by emoji',
    input: [reaction('a', 2), reaction('b', 1)],
    emoji: 'b',
    expected: [reaction('a', 2), reaction('b', 2, true)],
  },
  {
    name: 'removes the own vote while retaining other voters',
    input: [reaction('a', 3, true), reaction('b', 1)],
    emoji: 'a',
    expected: [reaction('a', 2), reaction('b', 1)],
  },
  {
    name: 'removes a reaction group when its last voter leaves',
    input: [reaction('b', 3), reaction('a', 1, true)],
    emoji: 'a',
    expected: [reaction('b', 3)],
  },
  {
    name: 'switches the own vote and sorts descending counts with an emoji tie',
    input: [reaction('c', 5), reaction('a', 3, true), reaction('b', 1)],
    emoji: 'b',
    expected: [reaction('c', 5), reaction('a', 2), reaction('b', 2, true)],
  },
  {
    name: 'switches the only vote from the old group into an existing group',
    input: [reaction('b', 3), reaction('a', 1, true)],
    emoji: 'b',
    expected: [reaction('b', 4, true)],
  },
  {
    name: 'switches to a new group and retains the old group other voters',
    input: [reaction('c', 4), reaction('a', 2, true)],
    emoji: 'b',
    expected: [reaction('c', 4), reaction('a', 1), reaction('b', 1, true)],
  },
  {
    name: 'sorts tied groups independently of their input order',
    input: [reaction('b', 1), reaction('a', 1)],
    emoji: 'c',
    expected: [reaction('a', 1), reaction('b', 1), reaction('c', 1, true)],
  },
  {
    name: 'switches Unicode emoji without relying on a locale ordering tie',
    input: [reaction('👍', 4, true), reaction('❤️', 1)],
    emoji: '❤️',
    expected: [reaction('👍', 3), reaction('❤️', 2, true)],
  },
];

for (const scenario of singleToggles) {
  test(scenario.name, () => {
    const input = freeze(dialog([message('target', scenario.input)]));
    const before = structuredClone(input);
    const output = toggleDialogReactionLocally(input, 'target', scenario.emoji);

    assert.ok(output);
    assert.deepEqual(output.messages[0]?.reactionGroups, scenario.expected);
    assert.deepEqual(input, before);
  });
}

const repeatedToggles: Array<{
  name: string;
  input: ChannelDialogReactionGroup[];
  emoji: string;
  first: ChannelDialogReactionGroup[];
  second: ChannelDialogReactionGroup[];
}> = [
  {
    name: 'two canonical toggles restore counts and ownership when initially no reaction is own',
    input: [reaction('a', 2), reaction('b', 1)],
    emoji: 'b',
    first: [reaction('a', 2), reaction('b', 2, true)],
    second: [reaction('a', 2), reaction('b', 1)],
  },
  {
    name: 'two canonical toggles restore the initially selected target after removing its group',
    input: [reaction('b', 3), reaction('a', 1, true)],
    emoji: 'a',
    first: [reaction('b', 3)],
    second: [reaction('b', 3), reaction('a', 1, true)],
  },
  {
    name: 'switching then removing a different reaction does not restore the previous selection',
    input: [reaction('a', 2, true), reaction('b', 1)],
    emoji: 'b',
    first: [reaction('b', 2, true), reaction('a', 1)],
    second: [reaction('a', 1), reaction('b', 1)],
  },
  {
    name: 'switching then removing does not recreate a vanished previous reaction group',
    input: [reaction('b', 1), reaction('a', 1, true)],
    emoji: 'b',
    first: [reaction('b', 2, true)],
    second: [reaction('b', 1)],
  },
];

for (const scenario of repeatedToggles) {
  test(scenario.name, () => {
    const input = freeze(dialog([message('target', scenario.input)]));
    const before = structuredClone(input);
    const first = toggleDialogReactionLocally(input, 'target', scenario.emoji);

    assert.ok(first);
    assert.deepEqual(first.messages[0]?.reactionGroups, scenario.first);
    const firstBefore = structuredClone(first);
    freeze(first);
    const second = toggleDialogReactionLocally(first, 'target', scenario.emoji);

    assert.ok(second);
    assert.deepEqual(second.messages[0]?.reactionGroups, scenario.second);
    assert.deepEqual(input, before);
    assert.deepEqual(first, firstBefore);
  });
}

test('a reaction update preserves metadata and unrelated references without mutating frozen data', () => {
  const input = freeze(
    dialog([
      message('before', [reaction('a', 3)]),
      message('target', [reaction('c', 5), reaction('a', 3, true), reaction('b', 1)]),
      message('after', [reaction('b', 2, true)]),
    ]),
  );
  const before = structuredClone(input);
  const target = input.messages[1]!;
  const output = toggleDialogReactionLocally(input, 'target', 'b');

  assert.ok(output);
  const updated = output.messages[1]!;
  assert.deepEqual(updated.reactionGroups, [
    reaction('c', 5),
    reaction('a', 2),
    reaction('b', 2, true),
  ]);
  assert.deepEqual(updated, { ...target, reactionGroups: updated.reactionGroups });
  assert.deepEqual(output, { ...input, messages: [input.messages[0], updated, input.messages[2]] });
  assert.notEqual(output, input);
  assert.notEqual(output.messages, input.messages);
  assert.notEqual(updated, target);
  assert.notEqual(updated.reactionGroups, target.reactionGroups);
  assert.equal(updated.reactionGroups[0], target.reactionGroups[0]);
  assert.notEqual(updated.reactionGroups[1], target.reactionGroups[1]);
  assert.notEqual(updated.reactionGroups[2], target.reactionGroups[2]);
  assert.equal(output.messages[0], input.messages[0]);
  assert.equal(output.messages[2], input.messages[2]);
  assert.equal(output.notificationSettings, input.notificationSettings);
  assert.equal(updated.attachments, target.attachments);
  assert.equal(updated.attachments[0], target.attachments[0]);
  assert.equal(updated.replyTo, target.replyTo);
  assert.deepEqual(input, before);
});
