import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Redis from 'ioredis';
import {
  ANTIDUPLICATE_CORPUS_VERSION,
  corpusDigest,
  hashCorpusFile,
  type AntiduplicateCorpusEvent,
  type AntiduplicateCorpusLabel,
} from './antiduplicate-corpus';
import { OfflineDuplicateWindow, replayAntiduplicateCorpus } from './replay-antiduplicate-corpus';
import {
  MessageDuplicateHistoryService,
  duplicateSourceDigest,
} from '../moderation/message-duplicate/message-duplicate-history.service';
import { extractDuplicateMessageContent } from '../moderation/message-duplicate/message-duplicate-content';
import { duplicateSettings } from '../moderation/message-duplicate/message-duplicate-test-fixtures';
import { PHOTO_FINGERPRINT_ALGORITHM_VERSION } from '../moderation/photo-duplicate/photo-fingerprint-version';
import { MESSAGE_DUPLICATE_HISTORY_STORAGE_VERSION } from '../moderation/message-duplicate/message-duplicate-window.script';
import { MESSAGE_DUPLICATE_MEDIA_VERSION } from '../moderation/message-duplicate/message-duplicate-state';
import type { RedisCounterService } from '../moderation/redis-counter.service';

const url = process.env.MAXIM_TEST_REDIS_URL ?? '';
const local = /^redis:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/u.test(url);
(local ? describe : describe.skip)('message duplicate offline corpus real Redis', () => {
  let directory: string;
  let redis: Redis;
  let stdout: jest.SpyInstance;
  const settings = duplicateSettings({
    duplicateCompareMode: 'TEXT',
    duplicateWarnWindowSec: 3600,
  });
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'maxim-corpus-redis-'));
    await chmod(directory, 0o700);
    redis = new Redis(url);
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(async () => {
    stdout.mockRestore();
    await redis.quit();
    await rm(directory, { recursive: true, force: true });
  });

  function event(
    messageId: string,
    iso: string,
    text = 'real sequence',
    overrides: Partial<AntiduplicateCorpusEvent> = {},
  ): AntiduplicateCorpusEvent {
    const at = Date.parse(iso);
    return {
      type: 'EVENT',
      id: corpusDigest([messageId, iso, overrides.eventType]),
      chatId: '-123',
      userId: '123',
      messageId,
      eventType: 'message_created',
      eventAt: new Date(at).toISOString(),
      receivedAt: new Date(at + 10).toISOString(),
      publishedAt: new Date(at).toISOString(),
      historicalAction: 'UNKNOWN',
      raw: {
        update_type: 'message_created',
        timestamp: at,
        message: {
          timestamp: at,
          sender: { user_id: '123' },
          recipient: { chat_id: '-123' },
          body: { mid: messageId, text },
        },
      },
      ...overrides,
    };
  }
  async function run(
    events: AntiduplicateCorpusEvent[],
    configuration = settings,
    reviewed: Array<{
      index: number;
      duplicate: boolean;
      actionAllowed: boolean;
      reviewerKind?: 'HUMAN' | 'AGENT';
    }> = [],
    corpusMutator?: (records: unknown[]) => unknown[],
  ) {
    const chatSettings = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        index === 0 ? '-123' : `-${index + 1000}`,
        configuration,
      ]),
    );
    // An untouched selected stratum must stay visibly uncovered in the holdout.
    chatSettings['-1001'] = duplicateSettings({
      duplicateDetectionPreset: 'STRICT',
      duplicateCompareMode: 'TEXT',
    });
    let records: unknown[] = [
      {
        type: 'MANIFEST',
        version: ANTIDUPLICATE_CORPUS_VERSION,
        sourceSnapshotSha256: 'a'.repeat(64),
        sourceSnapshotAt: '2026-08-27T12:00:00.000Z',
        warmupFrom: '2026-08-13T00:00:00.000Z',
        from: '2026-08-20T00:00:00.000Z',
        until: '2026-08-27T00:00:00.000Z',
        holdoutFrom: '2026-08-25T00:00:00.000Z',
        settingsBasis: 'SNAPSHOT_REPLAY',
        cohortComplete: true,
        sourceComplete: false,
        selectedChats: 20,
        eligibleChats: 20,
        settings: chatSettings,
      },
      ...events,
      {
        type: 'END',
        scanned: events.length,
        exported: events.length,
        rejected: 0,
        saturated: false,
        sourceComplete: true,
      },
    ];
    if (corpusMutator) records = corpusMutator(records);
    const input = join(directory, `${randomUUID()}.jsonl`);
    const output = join(directory, `${randomUUID()}.decisions.jsonl`);
    const summaryPath = join(directory, `${randomUUID()}.summary.json`);
    await writeFile(input, `${records.map((value) => JSON.stringify(value)).join('\n')}\n`, {
      mode: 0o600,
    });
    const sha = await hashCorpusFile(input);
    const labels = reviewed.map(
      ({ index, reviewerKind = 'HUMAN', ...label }) =>
        ({
          ...label,
          id: events[index]!.id,
          corpusSha256: sha,
          reviewerKind,
          reviewer: 'independent-fixture-review',
          reviewedAt: '2026-08-28T00:00:00.000Z',
        }) satisfies AntiduplicateCorpusLabel,
    );
    const labelsPath = join(directory, `${randomUUID()}.labels.jsonl`);
    await writeFile(labelsPath, labels.map((value) => JSON.stringify(value)).join('\n'), {
      mode: 0o600,
    });
    const summary = await replayAntiduplicateCorpus([
      '--input',
      input,
      '--output',
      output,
      '--summary',
      summaryPath,
      '--labels',
      labelsPath,
    ]);
    const decisions = (await readFile(output, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    return { summary, decisions, input, output, summaryPath };
  }

  it('preserves production allowance and simulated TTL for a past clock without real TTL or unrelated cleanup', async () => {
    const sentinel = `corpus-unrelated:${randomUUID()}`;
    await redis.set(sentinel, 'untouched');
    const window = new OfflineDuplicateWindow(redis);
    const history = new MessageDuplicateHistoryService(window as unknown as RedisCounterService);
    const chatId = randomUUID();
    const content = extractDuplicateMessageContent({ message: { body: { text: 'same' } } });
    const configuration = duplicateSettings({
      duplicateCompareMode: 'TEXT',
      duplicateBotMessageEnabled: true,
      duplicateWarnMaxCount: 3,
      duplicateWarnWindowSec: 60,
    });
    const start = Date.parse('2020-01-01T00:00:00Z');
    const observe = async (messageId: string, elapsed: number) => {
      window.now = start + elapsed;
      return history.observeWithOutcome({
        chatId,
        userId: '123',
        messageId,
        eventTimestampMs: window.now,
        publishedAtMs: window.now,
        controlRevision: 1,
        content,
        settings: configuration,
      });
    };
    try {
      expect((await observe('original', 0)).match).toBeNull();
      expect((await observe('allowed-copy', 100)).match).toBeNull();
      expect(window.candidates).toHaveLength(1);
      expect((await observe('violation', 200)).match?.binding.original?.messageId).toBe('original');
      const keys = await redis.keys('offline-antiduplicate:*');
      const stateKeys = keys.filter((key) =>
        key.includes(`:${MESSAGE_DUPLICATE_HISTORY_STORAGE_VERSION}:`),
      );
      expect(stateKeys.length).toBeGreaterThan(0);
      expect(await redis.pttl(stateKeys[0]!)).toBe(-1);
      expect((await observe('after-simulated-expiry', 300000)).match).toBeNull();
      expect(window.candidates).toHaveLength(0);
    } finally {
      await window.close();
      expect(await redis.get(sentinel)).toBe('untouched');
      await redis.del(sentinel);
    }
  });

  it('replays the complete ordered warmup, transport retries, edits, removals and independent holdout labels', async () => {
    const first = event('warmup', '2026-08-19T23:59:00Z');
    const development = event('development-copy', '2026-08-20T00:00:00Z');
    const original = event('holdout-original', '2026-08-25T10:00:00Z');
    const repeat = event('holdout-copy', '2026-08-25T10:00:00.100Z');
    const retry = {
      ...repeat,
      id: corpusDigest('transport-receipt'),
      receivedAt: '2026-08-25T10:00:00.200Z',
    };
    const edited = event('holdout-original', '2026-08-25T10:00:00.300Z', 'different', {
      eventType: 'message_edited',
      publishedAt: original.publishedAt,
    });
    edited.raw = {
      ...edited.raw,
      update_type: 'message_edited',
      message: { ...(edited.raw.message as object), timestamp: Date.parse(original.publishedAt!) },
    };
    const removed = event('holdout-copy', '2026-08-25T10:00:00.400Z', '', {
      eventType: 'message_removed',
      userId: null,
      publishedAt: null,
    });
    removed.raw = {
      update_type: 'message_removed',
      timestamp: Date.parse(removed.eventAt),
      chat_id: '-123',
      message_id: removed.messageId,
    };
    const last = event('after-lifecycle', '2026-08-25T10:00:00.500Z');
    const { summary, decisions } = await run(
      [first, development, original, repeat, retry, edited, removed, last],
      settings,
      [
        { index: 1, duplicate: true, actionAllowed: true },
        { index: 3, duplicate: true, actionAllowed: true },
        { index: 4, duplicate: true, actionAllowed: true },
        { index: 7, duplicate: false, actionAllowed: false, reviewerKind: 'AGENT' },
      ],
    );
    expect(decisions[1]).toMatchObject({
      partition: 'DEVELOPMENT',
      predictedDuplicate: true,
      predictedAction: true,
      originalMessageId: 'warmup',
    });
    expect(decisions[3]).toMatchObject({
      partition: 'HOLDOUT',
      predictedDuplicate: true,
      predictedAction: true,
    });
    expect(decisions[4]).toMatchObject({ outcome: 'TRANSPORT_REPLAY', scorable: false });
    expect(decisions[6]).toMatchObject({ outcome: 'LIFECYCLE_REMOVED', scorable: false });
    expect(decisions[7]).toMatchObject({ predictedDuplicate: false, predictedAction: false });
    expect(summary.development).toMatchObject({ humanLabels: 1, content: { tp: 1, fn: 0 } });
    expect(summary.holdout).toMatchObject({ humanLabels: 1, content: { tp: 1, fn: 0, fp: 0 } });
    expect(summary.unscorableHumanLabels).toBe(1);
    expect(
      summary.holdoutPolicyStrata.some((group) => group.events === 0 && group.humanLabels === 0),
    ).toBe(true);
    expect(summary.acceptance).toBe('INCOMPLETE');
  });

  it.each(['MESSAGE', 'TEXT'] as const)(
    'scores a repeated caption with different unverified photos under retained %s settings',
    async (duplicateCompareMode) => {
      const first = event('caption-a', '2026-08-25T11:00:00Z', 'repeated caption');
      const copy = event('caption-b', '2026-08-25T11:00:00.100Z', 'repeated caption');
      for (const item of [first, copy]) {
        const message = item.raw.message as Record<string, unknown>;
        message.body = {
          ...(message.body as object),
          attachments: [
            {
              type: 'image',
              payload: { url: `https://i.oneme.ru/${item.messageId}`, photo_id: item.messageId },
            },
          ],
        };
      }
      const { summary, decisions } = await run(
        [first, copy],
        duplicateSettings({ duplicateCompareMode }),
        [{ index: 1, duplicate: true, actionAllowed: true }],
      );
      expect(decisions[1]).toMatchObject({
        mode: 'TEXT',
        kind: 'image',
        outcome: 'MATCHED',
        predictedDuplicate: true,
        predictedAction: true,
        originalMessageId: first.messageId,
        scorable: true,
      });
      expect(summary.holdout).toMatchObject({ humanLabels: 1, content: { tp: 1, fn: 0, fp: 0 } });
      expect(summary.unscorableHumanLabels).toBe(0);
    },
  );

  it.each(['MESSAGE', 'TEXT'] as const)(
    'retains verified non-photo media fallback under retained %s settings',
    async (duplicateCompareMode) => {
      const first = event('file-a', '2026-08-25T11:00:00Z', '');
      const copy = event('file-b', '2026-08-25T11:00:00.100Z', '');
      for (const item of [first, copy]) {
        const message = item.raw.message as Record<string, unknown>;
        message.body = {
          ...(message.body as object),
          attachments: [
            { type: 'file', payload: { url: `https://fd.oneme.ru/${item.messageId}` } },
          ],
        };
        item.mediaProof = {
          sourceDigest: duplicateSourceDigest(extractDuplicateMessageContent(item.raw), 'MESSAGE'),
          algorithmVersion: MESSAGE_DUPLICATE_MEDIA_VERSION,
          hashes: ['b'.repeat(64)],
        };
      }
      const { decisions } = await run([first, copy], duplicateSettings({ duplicateCompareMode }), [
        { index: 1, duplicate: true, actionAllowed: true },
      ]);
      expect(decisions[1]).toMatchObject({
        mode: 'MESSAGE',
        kind: 'other_media',
        predictedDuplicate: true,
        predictedAction: true,
        originalMessageId: first.messageId,
        scorable: true,
      });
    },
  );

  it('counts known unavailable media text, excludes unverified photo labels and requires exact IMAGE source/version binding', async () => {
    const first = event('image-a', '2026-08-25T11:00:00Z', 'original caption');
    const copy = event('image-b', '2026-08-25T11:00:00.100Z', 'changed caption');
    for (const item of [first, copy]) {
      const message = item.raw.message as Record<string, unknown>;
      message.body = {
        ...(message.body as object),
        attachments: [
          { type: 'image', payload: { url: 'https://i.oneme.ru/same', photo_id: 'same-photo' } },
        ],
      };
    }
    const imageSettings = duplicateSettings({ duplicateCompareMode: 'MESSAGE' });
    const unverified = await run([first, copy], imageSettings, [
      { index: 1, duplicate: true, actionAllowed: true },
    ]);
    expect(unverified.decisions[1]).toMatchObject({
      outcome: 'MEDIA_PROOF_UNAVAILABLE',
      scorable: false,
    });
    expect(unverified.summary.holdout).toMatchObject({ humanLabels: 0, content: { fn: 0, fp: 0 } });
    expect(
      unverified.summary.groups.some((group) => group.labels === 0 && group.events === 2),
    ).toBe(true);
    for (const item of [first, copy])
      item.mediaProof = {
        sourceDigest: duplicateSourceDigest(extractDuplicateMessageContent(item.raw), 'IMAGE'),
        algorithmVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
        hashes: ['a'.repeat(64)],
      };
    const proven = await run([first, copy], imageSettings, [
      { index: 1, duplicate: true, actionAllowed: true },
    ]);
    expect(proven.decisions[1]).toMatchObject({
      mode: 'IMAGE',
      predictedDuplicate: true,
      predictedAction: true,
      scorable: true,
    });
    copy.mediaProof!.sourceDigest = extractDuplicateMessageContent(copy.raw).sourceDigest;
    const wrongDigest = await run([first, copy], imageSettings);
    expect(wrongDigest.decisions[1]).toMatchObject({
      outcome: 'MEDIA_PROOF_UNAVAILABLE',
      scorable: false,
    });
    const unavailableText = [
      event('text-a', '2026-08-25T12:00:00Z'),
      event('text-b', '2026-08-25T12:00:00.100Z'),
    ];
    for (const item of unavailableText) {
      const message = item.raw.message as Record<string, unknown>;
      message.body = { ...(message.body as object), attachments: [{ type: 'video', payload: {} }] };
    }
    const textResult = await run(unavailableText, settings, [
      { index: 1, duplicate: true, actionAllowed: true },
    ]);
    expect(textResult.decisions[1]).toMatchObject({
      mode: 'TEXT',
      predictedDuplicate: true,
      predictedAction: true,
      scorable: true,
    });
  });

  it.each([
    'bad-end',
    'duplicate-id',
    'receipt-order',
    'raw-identity',
    'removal-identity',
  ] as const)('rejects %s and deletes only its partial private decisions', async (failure) => {
    const first = event('a', '2026-08-25T13:00:00Z');
    const second = event('b', '2026-08-25T13:00:00.100Z');
    const mutate = (records: unknown[]) => {
      if (failure === 'bad-end') (records.at(-1) as Record<string, unknown>).exported = 100;
      if (failure === 'duplicate-id') second.id = first.id;
      if (failure === 'receipt-order') second.receivedAt = '2026-08-25T12:59:59.000Z';
      if (failure === 'raw-identity') second.chatId = '-1001';
      if (failure === 'removal-identity') {
        second.eventType = 'message_removed';
        second.userId = null;
        second.publishedAt = null;
        second.raw = {
          update_type: 'message_removed',
          timestamp: Date.parse(second.eventAt),
          chat_id: '-123',
          message_id: 'other-message',
        };
      }
      return records;
    };
    await expect(run([first, second], settings, [], mutate)).rejects.toThrow();
    const files = await import('node:fs/promises').then((fs) => fs.readdir(directory));
    expect(
      files.some((name) => name.endsWith('.decisions.jsonl') || name.endsWith('.summary.json')),
    ).toBe(false);
  });

  it('refuses an output/input alias before Redis or output mutation', async () => {
    const input = join(directory, 'frozen.jsonl');
    await writeFile(input, 'private-frozen-input', { mode: 0o600 });
    const output = join(directory, 'summary.json');
    await expect(
      replayAntiduplicateCorpus(['--input', input, '--output', input, '--summary', output]),
    ).rejects.toThrow('distinct');
    expect(await readFile(input, 'utf8')).toBe('private-frozen-input');
    await expect(access(output)).rejects.toThrow();
  });
});
