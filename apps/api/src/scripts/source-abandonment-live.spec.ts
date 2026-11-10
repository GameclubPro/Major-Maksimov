import { LEGACY_RECOVERY_LIVE_QUEUE_NAMES } from './legacy-recovery-live-registry';
import { LEGACY_RECOVERY_LIVE_BUDGET } from './legacy-recovery-live-budget';
import {
  classifySourceAbandonmentAction,
  inventorySourceAbandonmentRedis,
  isUnrelatedSourceAbandonmentFanoutObservation,
  type SourceAbandonmentRedisResolver,
  type SourceAbandonmentRedisSource,
} from './source-abandonment-live-redis';
import * as cleanupProof from './source-abandonment-cleanup-proof';
import { SOURCE_ABANDONMENT_CHANNEL_PROFILE } from '../webhook/webhook-source-abandonment.contract';
import { mergeSourceAbandonmentChildren } from './source-abandonment-collect';
import {
  assertSourceAbandonmentCatalogProofs,
  inventorySourceAbandonmentNamespaces,
  projectSourceAbandonmentNamespaceCounts,
  readMeasuredSourceCatalogScript,
  SOURCE_ABANDONMENT_COMMANDSTATS_PROJECTION_SCRIPT,
  type SourceAbandonmentCatalogReader,
} from './source-abandonment-redis-catalog';
import {
  parseSourceAbandonmentSelection,
  SOURCE_ABANDONMENT_OBSERVATION_QUEUE,
  SOURCE_ABANDONMENT_CHANNEL_MARKER_QUEUE,
  sourceAbandonmentDigest,
} from './source-abandonment-live-protocol';

const source = { chatId: 'chat-1', messageId: 'message-1', userId: 'user-1' };
const selection = {
  protocol: 'source-abandonment-v1' as const,
  abandonBefore: '2026-10-07T00:00:00.000Z',
  ownerWebhookEventIds: ['owner-1'],
  majorBotIds: ['major-1'],
};
const job = (data: Record<string, unknown>) => ({
  id: 'job-1',
  state: 'wait',
  hash: { data: JSON.stringify(data) },
  data,
  position: 0,
  score: '',
});
const action = (fields: Record<string, unknown> = {}) =>
  job({
    actionType: 'DELETE_MESSAGE',
    chatId: source.chatId,
    messageId: source.messageId,
    userId: source.userId,
    idempotencyKey: 'action-1',
    ...fields,
  });
const allowance = () => ({ ...LEGACY_RECOVERY_LIVE_BUDGET, deadlineAtMs: Date.now() + 30000 });
const resolve = jest.fn<
  ReturnType<SourceAbandonmentRedisResolver>,
  Parameters<SourceAbandonmentRedisResolver>
>(async (_kind, keys) => ({
  rows: keys.map((key) => ({ key, row: null, digest: 'f'.repeat(64) })),
  cost: { pages: 0, rows: 0, probes: 0, bytes: 0 },
  plans: [],
  issue: null,
}));
const commandstats = (calls = 10, usec = 100, rejected = 0, failed = 0) =>
  `# Commandstats\r\ncmdstat_eval_ro:calls=${calls},usec=${usec},usec_per_call=10.00,rejected_calls=${rejected},failed_calls=${failed}\r\n`;
function measuredFixture<T extends SourceAbandonmentCatalogReader>(reader: T) {
  return Object.assign(reader, {
    multi() {
      const commands: Array<{ script: string; keys: number; args: string[] }> = [];
      const transaction = {
        eval_ro(nextScript: string, nextKeys: number, ...nextArgs: string[]) {
          commands.push({ script: nextScript, keys: nextKeys, args: nextArgs });
          return transaction;
        },
        async exec() {
          expect(commands).toHaveLength(3);
          const projection = {
            script: SOURCE_ABANDONMENT_COMMANDSTATS_PROJECTION_SCRIPT,
            keys: 0,
            args: [],
          };
          expect(commands[0]).toEqual(projection);
          expect(commands[2]).toEqual(projection);
          const { script, keys, args } = commands[1];
          let reply = await reader.eval_ro(script, keys, ...args);
          if (
            script.startsWith('-- source-abandonment:namespace-catalog') &&
            Array.isArray(reply) &&
            reply[0] === 1 &&
            reply.length === 7
          ) {
            const cursor = reply[2] as string;
            reply = [...reply, [cursor]];
          }
          return [
            [null, commandstats()],
            [null, reply],
            [null, commandstats(12, 200)],
          ];
        },
      };
      return transaction;
    },
  });
}
function redisFixture(keys: string[] = []) {
  return measuredFixture({
    eval_ro: jest.fn(async (script: string, _keyCount: number, ...args: string[]) => {
      if (script.startsWith('-- source-abandonment:headers'))
        return [
          1,
          1,
          [...LEGACY_RECOVERY_LIVE_QUEUE_NAMES]
            .sort()
            .map((name) => [name, '', '1', '', 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        ];
      if (script.startsWith('-- source-abandonment:namespace-catalog-v2'))
        return keys.length ? [0, 'UNKNOWN_QUEUE_NAMESPACE'] : [1, 0, '0', 0, 0, 0, []];
      if (script.startsWith('-- source-abandonment:owners'))
        return [1, 1, JSON.parse(args[1]).length, []];
      throw new Error('Unexpected read');
    }),
  });
}

function actionPagesFixture(data: readonly Record<string, unknown>[]) {
  const base = redisFixture();
  return measuredFixture({
    eval_ro: jest.fn(async (script: string, keyCount: number, ...args: string[]) => {
      if (script.startsWith('-- source-abandonment:jobs')) {
        const offset = Number(args[2]);
        const page = data.slice(offset, offset + Number(args[3]));
        return [
          1,
          1,
          page.length,
          page.map((value, index) => [
            `job-${offset + index}`,
            'wait',
            ['data', JSON.stringify(value)],
            offset + index,
            '',
          ]),
        ];
      }
      const reply = await base.eval_ro(script, keyCount, ...args);
      if (script.startsWith('-- source-abandonment:headers')) {
        const rows = reply[2] as unknown as Array<Array<string | number>>;
        rows.find((row) => row[0] === 'max-actions-background')![4] = data.length;
      }
      return reply;
    }),
  });
}

describe('exact source abandonment bounded evidence', () => {
  it('preserves namespace presence and every count outside the two independent Publisher queues', () => {
    const first = {
      'publisher-start': 5,
      'publisher-binding-refresh': 7,
      'max-actions-background': 9,
    };
    const stable = projectSourceAbandonmentNamespaceCounts(first);
    expect(stable).toEqual({
      'publisher-start': null,
      'publisher-binding-refresh': null,
      'max-actions-background': 9,
    });
    expect(projectSourceAbandonmentNamespaceCounts({ ...first, 'publisher-start': 3 })).toEqual(
      stable,
    );
    expect(
      projectSourceAbandonmentNamespaceCounts({ ...first, 'max-actions-background': 8 }),
    ).not.toEqual(stable);
    expect(
      projectSourceAbandonmentNamespaceCounts({
        'publisher-start': 5,
        'max-actions-background': 9,
      }),
    ).not.toEqual(stable);
  });

  it('records actual server cost despite delayed delivery and frozen Lua TIME', async () => {
    const reader = measuredFixture({
      eval_ro: async () => {
        await new Promise((resolve) => setTimeout(resolve, 70));
        return [1, 0, '0', 0, 0, 0, []];
      },
    });
    const proof = await inventorySourceAbandonmentNamespaces(reader, Date.now() + 1000);
    expect(proof).toMatchObject({
      complete: true,
      issue: null,
      cost: { serverDurationUs: 100, maxCallDurationUs: 100 },
    });
  });
  it.each([[], ['0', '2'], ['1'], ['1', '2'], ['1', '2', '3']])(
    'rejects malformed or multiple page cursor accounting',
    async (...cursors) => {
      const reader = measuredFixture({ eval_ro: async () => [1, 0, '2', 0, 0, 0, [], cursors] });
      expect(await inventorySourceAbandonmentNamespaces(reader, Date.now() + 1000)).toMatchObject({
        complete: false,
        issue: 'CATALOG_REPLY_UNPROVED',
      });
    },
  );
  it.each([
    [commandstats(12, 50_101), 'CATALOG_CALL_LATENCY_LIMIT'],
    [commandstats(0, 0), 'CATALOG_SERVER_COST_UNPROVED'],
    [commandstats(11, 200), 'CATALOG_SERVER_COST_UNPROVED'],
    [commandstats(13, 200), 'CATALOG_SERVER_COST_UNPROVED'],
    [commandstats(12, 99), 'CATALOG_SERVER_COST_UNPROVED'],
    [commandstats(12, 200, 1), 'CATALOG_SERVER_COST_UNPROVED'],
    [commandstats(12, 200, 0, 1), 'CATALOG_SERVER_COST_UNPROVED'],
    [commandstats(12, Number.MAX_SAFE_INTEGER + 1), 'CATALOG_SERVER_COST_UNPROVED'],
    [commandstats(Number.MAX_SAFE_INTEGER + 1, 200), 'CATALOG_SERVER_COST_UNPROVED'],
    [`${commandstats(12, 200)}${commandstats(12, 200)}`, 'CATALOG_SERVER_COST_UNPROVED'],
    [`${commandstats(12, 200)}${'x'.repeat(512)}`, 'CATALOG_SERVER_COST_UNPROVED'],
    ['secret raw error', 'CATALOG_SERVER_COST_UNPROVED'],
  ])(
    'refuses invalid commandstats rather than accepting a zero Lua duration',
    async (after, issue) => {
      const reader = measuredFixture({ eval_ro: async () => [1, 0, '0', 0, 0, 0, []] });
      const multi = reader.multi.bind(reader);
      reader.multi = () => {
        const transaction = multi();
        const exec = transaction.exec.bind(transaction);
        transaction.exec = async () => {
          const rows = await exec();
          rows[2][1] = after;
          return rows;
        };
        return transaction;
      };
      await expect(readMeasuredSourceCatalogScript(reader, 'read', 0)).rejects.toThrow(issue);
    },
  );
  it.each([0, 1, 2])('refuses an error in measured transaction command %i', async (index) => {
    const reader = measuredFixture({ eval_ro: async () => 'target reply' });
    const multi = reader.multi.bind(reader);
    reader.multi = () => {
      const transaction = multi();
      const exec = transaction.exec.bind(transaction);
      transaction.exec = async () => {
        const rows = await exec();
        rows[index][0] = new Error('private Redis error');
        return rows;
      };
      return transaction;
    };
    await expect(readMeasuredSourceCatalogScript(reader, 'read', 0)).rejects.toThrow(
      'CATALOG_SERVER_COST_UNPROVED',
    );
  });
  it('accepts a canonical absent baseline and charges only the bounded projections', async () => {
    const reader = measuredFixture({ eval_ro: async () => 'target reply' });
    const multi = reader.multi.bind(reader);
    const before = '# Commandstats\r\n';
    const after = commandstats(2, 50_000);
    reader.multi = () => {
      const transaction = multi();
      const exec = transaction.exec.bind(transaction);
      transaction.exec = async () => {
        const rows = await exec();
        rows[0][1] = before;
        rows[2][1] = after;
        return rows;
      };
      return transaction;
    };
    await expect(readMeasuredSourceCatalogScript(reader, 'read', 0)).resolves.toEqual({
      reply: 'target reply',
      serverDurationUs: 50_000,
      measurementBytes: Buffer.byteLength(before) + Buffer.byteLength(after),
    });
  });
  it('binds an exact original message and never a distinct message by the same member', () => {
    expect(classifySourceAbandonmentAction(action(), [source])).toMatchObject({
      ...source,
      jobKey: 'action-1',
    });
    expect(
      classifySourceAbandonmentAction(action({ messageId: 'other-message' }), [source]),
    ).toBeNull();
  });
  it('binds an explicitly proven authorless channel source without inventing a user', () => {
    const channel: SourceAbandonmentRedisSource = {
      chatId: source.chatId,
      messageId: source.messageId,
      userId: null,
      sourceProfile: SOURCE_ABANDONMENT_CHANNEL_PROFILE,
    };
    const child = classifySourceAbandonmentAction(action({ userId: null }), [channel]);
    expect(child).toMatchObject({
      chatId: channel.chatId,
      messageId: channel.messageId,
      jobKey: 'action-1',
    });
    expect(child).not.toHaveProperty('userId');
    expect(() => classifySourceAbandonmentAction(action(), [channel])).toThrow(
      'ACTION_SUBJECT_CONFLICT',
    );
    expect(
      classifySourceAbandonmentAction(action({ messageId: 'other-message' }), [channel]),
    ).toBeNull();
  });
  it.each([
    { userId: null },
    { userId: 'invented', sourceProfile: SOURCE_ABANDONMENT_CHANNEL_PROFILE },
    { userId: null, sourceProfile: 'unknown' },
  ])('refuses incomplete authorless source metadata before Redis I/O: %j', async (changed) => {
    const invalid = { ...source, ...changed } as unknown as SourceAbandonmentRedisSource;
    expect(() => classifySourceAbandonmentAction(action(), [invalid])).toThrow(
      'SOURCE_PROFILE_UNPROVED',
    );
    const redis = redisFixture();
    const result = await inventorySourceAbandonmentRedis(
      redis,
      selection,
      [invalid],
      allowance(),
      resolve,
      'nonce',
    );
    expect(result.issues).toContainEqual({
      code: 'SOURCE_PROFILE_UNPROVED',
      descriptor: 'redis:inventory',
    });
    expect(redis.eval_ro).not.toHaveBeenCalled();
  });
  it('does not infer global FANOUT disjointness from an authorless channel', () => {
    const data = {
      observationId: 'observation-1',
      userId: '300',
      chatId: '-300',
      source: 'FANOUT_HIGH',
      fastPath: false,
    };
    const observation = { ...data, id: data.observationId, messageId: null };
    const human = { ...source, userId: '100', chatId: '-100' };
    const channel: SourceAbandonmentRedisSource = {
      chatId: '-200',
      messageId: 'channel-message',
      userId: null,
      sourceProfile: SOURCE_ABANDONMENT_CHANNEL_PROFILE,
    };
    expect(isUnrelatedSourceAbandonmentFanoutObservation(data, observation, [human])).toBe(true);
    expect(isUnrelatedSourceAbandonmentFanoutObservation(data, observation, [channel])).toBe(false);
    expect(isUnrelatedSourceAbandonmentFanoutObservation(data, observation, [human, channel])).toBe(
      false,
    );
  });
  it('binds an explicit notice original source even when action target differs', () => {
    expect(
      classifySourceAbandonmentAction(
        action({
          actionType: 'SEND_MESSAGE',
          messageId: undefined,
          ledgerContext: { moderationSource: source },
        }),
        [source],
      ),
    ).toMatchObject(source);
  });
  it.each([
    { actionType: 'BAN_MEMBER', messageId: undefined },
    { actionType: 'SEND_MESSAGE', messageId: undefined },
    { ledgerContext: { unknownProducer: { ...source } } },
    { userId: 'different-user' },
    { sendAutoDelete: { sourceSendJobId: 'old-send' } },
  ])('refuses unattributed or conflicting continuation %#', (fields) => {
    expect(() => classifySourceAbandonmentAction(action(fields), [source])).toThrow();
  });
  it('rejects parent/repeat work before source attribution', () => {
    const input = action();
    input.hash = {
      ...input.hash,
      opts: JSON.stringify({ repeat: { every: 1000 } }),
    } as typeof input.hash;
    expect(() => classifySourceAbandonmentAction(input, [source])).toThrow('JOB_PARENT_UNPROVED');
  });
  it('deduplicates the exact persisted observation across SQL and Redis while rejecting conflicting content', () => {
    const child = {
      ...source,
      jobKey: 'observation-1',
      queueName: SOURCE_ABANDONMENT_OBSERVATION_QUEUE,
      jobPayloadDigest: 'a'.repeat(64),
    };
    expect(mergeSourceAbandonmentChildren([[child], [child]])).toEqual([child]);
    expect(() =>
      mergeSourceAbandonmentChildren([[child], [{ ...child, jobPayloadDigest: 'b'.repeat(64) }]]),
    ).toThrow();
  });
  it('keeps channel marker keys separate from action and observation keys', () => {
    const marker = {
      chatId: source.chatId,
      messageId: source.messageId,
      jobKey: 'same-key',
      queueName: SOURCE_ABANDONMENT_CHANNEL_MARKER_QUEUE,
      jobPayloadDigest: 'a'.repeat(64),
    };
    const actionChild = { ...marker, queueName: 'max-actions-background' };
    const observation = { ...marker, queueName: SOURCE_ABANDONMENT_OBSERVATION_QUEUE };
    expect(
      mergeSourceAbandonmentChildren([[marker, actionChild, observation], [marker]]),
    ).toHaveLength(3);
    expect(() =>
      mergeSourceAbandonmentChildren([[marker], [{ ...marker, jobPayloadDigest: 'b'.repeat(64) }]]),
    ).toThrow('Exact child conflict');
  });
  it('rejects a noncanonical cutoff and a source selection beyond eight owners', () => {
    expect(() =>
      parseSourceAbandonmentSelection({ ...selection, abandonBefore: '2026-10-07' }),
    ).toThrow();
    expect(() =>
      parseSourceAbandonmentSelection({
        ...selection,
        ownerWebhookEventIds: Array.from({ length: 9 }, (_, i) => `owner-${i}`),
      }),
    ).toThrow();
    expect(parseSourceAbandonmentSelection(selection)).toEqual(selection);
  });
  it('requires a complete finite namespace catalog before cold admission', async () => {
    const valid = await inventorySourceAbandonmentRedis(
      redisFixture(),
      selection,
      [source],
      allowance(),
      resolve,
      'nonce',
    );
    expect(valid.issues).toEqual([]);
    const unknown = await inventorySourceAbandonmentRedis(
      redisFixture(['bull:unexpected-queue:wait']),
      selection,
      [source],
      allowance(),
      resolve,
      'nonce',
    );
    expect(unknown.issues).toContainEqual({
      code: 'UNKNOWN_QUEUE_NAMESPACE',
      descriptor: 'redis:namespace-catalog',
    });
  });

  it.each<{ name: string; change: Record<string, unknown> | null; allowed: boolean }>([
    { name: 'independent non-message fanout', change: {}, allowed: true },
    { name: 'missing persisted row', change: null, allowed: false },
    { name: 'stale row identity', change: { id: 'other-observation' }, allowed: false },
    { name: 'conflicting source kind', change: { source: 'FANOUT_REPEAT' }, allowed: false },
    { name: 'missing message field', change: { messageId: undefined }, allowed: false },
    { name: 'same member in another chat', change: { userId: '100' }, allowed: false },
    { name: 'another member in same chat', change: { chatId: '-100' }, allowed: false },
  ])('retains observation evidence and refuses unproved independence: $name', async (testCase) => {
    const data = {
      observationId: 'observation-1',
      userId: '300',
      chatId: '-300',
      source: 'FANOUT_HIGH',
      fastPath: false,
      ...(testCase.change?.userId ? { userId: testCase.change.userId } : {}),
      ...(testCase.change?.chatId ? { chatId: testCase.change.chatId } : {}),
    };
    const persisted =
      testCase.change === null
        ? null
        : {
            id: data.observationId,
            userId: data.userId,
            chatId: data.chatId,
            source: data.source,
            messageId: null,
            ...testCase.change,
          };
    const base = redisFixture();
    const redis = measuredFixture({
      eval_ro: jest.fn(async (script: string, keyCount: number, ...args: string[]) => {
        if (script.startsWith('-- source-abandonment:jobs'))
          return [
            1,
            1,
            1,
            [['delayed-fanout-job', 'delayed', ['data', JSON.stringify(data)], 0, '1']],
          ];
        const reply = await base.eval_ro(script, keyCount, ...args);
        if (script.startsWith('-- source-abandonment:headers')) {
          const rows = reply[2] as unknown as Array<Array<string | number>>;
          rows.find((row) => row[0] === 'global-spammer-denorm')![7] = 1;
        }
        return reply;
      }),
    });
    const resolver = jest.fn<
      ReturnType<SourceAbandonmentRedisResolver>,
      Parameters<SourceAbandonmentRedisResolver>
    >(async (_kind, keys) => ({
      rows: keys.map((key) => ({ key, row: persisted, digest: 'a'.repeat(64) })),
      cost: { pages: 2, rows: 2, probes: 2, bytes: 100 },
      plans: [],
      issue: null,
    }));
    const result = await inventorySourceAbandonmentRedis(
      redis,
      selection,
      [{ ...source, userId: '100', chatId: '-100' }],
      allowance(),
      resolver,
      'nonce',
    );
    expect(resolver).toHaveBeenCalledWith('observation', [data.observationId], expect.any(Object));
    expect(result.children).toEqual([]);
    if (!testCase.allowed) {
      expect(result.issues[0]?.code).toBe('OBSERVATION_SOURCE_UNPROVED');
      return;
    }
    expect(result.issues).toEqual([]);
    expect(result.cost.rows).toBeGreaterThanOrEqual(2);
    resolver.mockResolvedValue({
      rows: [{ key: data.observationId, row: persisted, digest: 'b'.repeat(64) }],
      cost: { pages: 2, rows: 2, probes: 2, bytes: 100 },
      plans: [],
      issue: null,
    });
    const changed = await inventorySourceAbandonmentRedis(
      redis,
      selection,
      [{ ...source, userId: '100', chatId: '-100' }],
      allowance(),
      resolver,
      'nonce',
    );
    expect(changed.issues).toEqual([]);
    expect(changed.stableDigest).not.toBe(result.stableDigest);
  });

  it.each([
    {
      actionType: 'SEND_MESSAGE',
      status: 'FAILED_TERMINAL',
      ambiguous: false,
      terminal: true,
      remoteMessageId: null,
      expected: 'DENY',
    },
    {
      actionType: 'SEND_MESSAGE',
      status: 'SUCCEEDED',
      ambiguous: false,
      terminal: true,
      remoteMessageId: 'sent-notice',
      expected: 'DENY',
    },
    {
      actionType: 'SEND_MESSAGE',
      status: 'AMBIGUOUS',
      ambiguous: true,
      terminal: true,
      remoteMessageId: 'sent-notice',
      expected: 'DENY',
    },
    {
      actionType: 'BAN_MEMBER',
      status: 'AMBIGUOUS',
      ambiguous: true,
      terminal: false,
      remoteMessageId: null,
      expected: 'ALLOW_FENCED',
    },
    {
      actionType: 'KICK_MEMBER',
      status: 'IN_PROGRESS',
      ambiguous: false,
      terminal: false,
      remoteMessageId: null,
      expected: 'ALLOW_FENCED',
    },
  ])(
    'preserves a real effect fence without authorizing resumable $actionType/$status',
    async (state) => {
      const data = {
        actionType: state.actionType,
        chatId: source.chatId,
        userId: source.userId,
        idempotencyKey: 'action-1',
        autoDeleteDelayMs: 1000,
      };
      const base = redisFixture();
      const redis = measuredFixture({
        eval_ro: jest.fn(async (script: string, keyCount: number, ...args: string[]) => {
          if (script.startsWith('-- source-abandonment:jobs'))
            return [1, 1, 1, [['job-1', 'wait', ['data', JSON.stringify(data)], 0, '']]];
          const reply = await base.eval_ro(script, keyCount, ...args);
          if (script.startsWith('-- source-abandonment:headers')) {
            const rows = reply[2] as unknown as Array<Array<string | number>>;
            const queue = rows.find((row) => row[0] === 'max-actions-critical')!;
            queue[4] = 1;
          }
          return reply;
        }),
      });
      const resolver: SourceAbandonmentRedisResolver = async (_kind, keys) => ({
        rows: keys.map((key) => ({
          key,
          row: {
            jobId: 'action-1',
            chatId: source.chatId,
            userId: source.userId,
            messageId: null,
            ...state,
          },
          digest: 'f'.repeat(64),
        })),
        cost: { pages: 0, rows: 0, probes: 0, bytes: 0 },
        plans: [],
        issue: null,
      });
      const result = await inventorySourceAbandonmentRedis(
        redis,
        selection,
        [source],
        allowance(),
        resolver,
        'nonce',
      );
      if (state.expected === 'DENY') expect(result.issues[0]?.code).toBe('ACTION_SOURCE_UNPROVED');
      else {
        expect(result.issues).toEqual([]);
        expect(result.children).toEqual([]);
      }
    },
  );
  it.each(['missing', 'duplicate', 'extra'])(
    'refuses a %s batch key before attributing a queued action',
    async (malformation) => {
      const resolver: SourceAbandonmentRedisResolver = async (_kind, keys) => {
        expect(keys).toEqual(['action-1', 'action-2']);
        const rows = keys.map((key) => ({ key, row: null, digest: 'f'.repeat(64) }));
        if (malformation === 'missing') rows.pop();
        if (malformation === 'duplicate') rows[1] = { ...rows[0]! };
        if (malformation === 'extra')
          rows[1] = { key: 'unrequested', row: null, digest: 'e'.repeat(64) };
        return { rows, cost: { pages: 2, rows: 2, probes: 2, bytes: 128 }, plans: [], issue: null };
      };
      const result = await inventorySourceAbandonmentRedis(
        actionPagesFixture([action().data, action({ idempotencyKey: 'action-2' }).data]),
        selection,
        [source],
        allowance(),
        resolver,
        'nonce',
      );
      expect(result.children).toEqual([]);
      expect(result.issues).toEqual([
        { code: 'SQL_BATCH_REPLY_UNPROVED', descriptor: 'redis:max-actions-background' },
      ]);
    },
  );

  it('accepts an explicit null ledger result while retaining the exact requested key', async () => {
    const resolver = jest.fn<
      ReturnType<SourceAbandonmentRedisResolver>,
      Parameters<SourceAbandonmentRedisResolver>
    >(async (_kind, keys) => ({
      rows: keys.map((key) => ({ key, row: null, digest: sourceAbandonmentDigest([]) })),
      cost: { pages: 2, rows: 1, probes: 2, bytes: 128 },
      plans: [],
      issue: null,
    }));
    const result = await inventorySourceAbandonmentRedis(
      actionPagesFixture([action().data]),
      selection,
      [source],
      allowance(),
      resolver,
      'nonce',
    );
    expect(result.issues).toEqual([]);
    expect(result.children).toMatchObject([{ jobKey: 'action-1', ...source }]);
    expect(resolver.mock.calls.map(([kind, keys]) => [kind, keys])).toEqual([
      ['action', ['action-1']],
    ]);
  });

  it('retains a SQL refusal descriptor and charges its partial batch cost and plan once', async () => {
    const redis = actionPagesFixture([action().data]);
    const plan = {
      descriptor: 'sql:max_action_ledger',
      querySha256: 'a'.repeat(64),
      planSha256: 'b'.repeat(64),
      indexes: ['max_action_ledger_job_id_key'],
      returnedRows: 0,
      examinedRows: 2,
      probes: 1,
    };
    const resolver: SourceAbandonmentRedisResolver = async () => ({
      rows: [],
      cost: { pages: 2, rows: 3, probes: 7, bytes: 257 },
      plans: [plan],
      issue: { code: 'sql_budget_exceeded', descriptor: 'sql:max_action_ledger' },
    });
    const result = await inventorySourceAbandonmentRedis(
      redis,
      selection,
      [source],
      allowance(),
      resolver,
      'nonce',
    );
    const reads = redis.eval_ro.mock.calls.filter(([script]) =>
      /^-- source-abandonment:(headers|owners|jobs)/u.test(script),
    ).length;
    expect(result.issues).toEqual([
      { code: 'sql_budget_exceeded', descriptor: 'sql:max_action_ledger' },
    ]);
    expect(result.children).toEqual([]);
    expect(result.cost).toMatchObject({ pages: reads + 2, rows: 4, probes: reads + 7 });
    expect(result.cost.bytes).toBeGreaterThanOrEqual(257);
    expect(result.sqlPlans).toEqual([plan]);
  });

  it('preserves a completed SQL deadline refusal after the shared allowance expires', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const budget = { ...LEGACY_RECOVERY_LIVE_BUDGET, deadlineAtMs: now + 30_000 };
      const redis = actionPagesFixture([action().data]);
      const plan = {
        descriptor: 'sql:max_action_ledger',
        querySha256: 'a'.repeat(64),
        planSha256: 'b'.repeat(64),
        indexes: ['max_action_ledger_job_id_key'],
        returnedRows: 0,
        examinedRows: 2,
        probes: 1,
      };
      const resolver: SourceAbandonmentRedisResolver = async () => {
        clock.mockReturnValue(budget.deadlineAtMs);
        return {
          rows: [],
          cost: { pages: 1, rows: 0, probes: 1, bytes: 64 },
          plans: [plan],
          issue: { code: 'sql_deadline_exceeded', descriptor: 'sql:max_action_ledger' },
        };
      };
      const result = await inventorySourceAbandonmentRedis(
        redis,
        selection,
        [source],
        budget,
        resolver,
        'nonce',
      );
      const reads = redis.eval_ro.mock.calls.filter(([script]) =>
        /^-- source-abandonment:(headers|owners|jobs)/u.test(script),
      ).length;
      expect(result.issues).toEqual([
        { code: 'sql_deadline_exceeded', descriptor: 'sql:max_action_ledger' },
      ]);
      expect(result.children).toEqual([]);
      expect(result.cost).toMatchObject({ pages: reads + 1, rows: 1, probes: reads + 1 });
      expect(result.cost.bytes).toBeGreaterThanOrEqual(64);
      expect(result.sqlPlans).toEqual([plan]);
    } finally {
      clock.mockRestore();
    }
  });

  it('refetches a repeated key on page 17 and on the next inventory instead of caching a ledger', async () => {
    const data = Array.from(
      { length: 17 },
      (_, index) => action({ idempotencyKey: `action-${index % 16}` }).data,
    );
    let revision = 0;
    const resolver = jest.fn<
      ReturnType<SourceAbandonmentRedisResolver>,
      Parameters<SourceAbandonmentRedisResolver>
    >(async (_kind, keys) => {
      if (keys.length === 1) revision++;
      return {
        rows: keys.map((key) => {
          const row = {
            jobId: key,
            actionType: 'DELETE_MESSAGE',
            ...source,
            updatedAt: new Date(Date.parse('2026-10-01T00:00:00.000Z') + revision),
          };
          return { key, row, digest: sourceAbandonmentDigest([row]) };
        }),
        cost: { pages: 2, rows: keys.length, probes: 2, bytes: 256 },
        plans: [],
        issue: null,
      };
    });
    const observe = () =>
      inventorySourceAbandonmentRedis(
        actionPagesFixture(data),
        selection,
        [source],
        allowance(),
        resolver,
        'nonce',
      );
    const first = await observe();
    const second = await observe();
    expect(first.issues).toEqual([]);
    expect(second.issues).toEqual([]);
    expect(first.children).toHaveLength(16);
    expect(second.stableDigest).not.toBe(first.stableDigest);
    const firstKeys = Array.from({ length: 16 }, (_, index) => `action-${index}`);
    expect(resolver.mock.calls.map(([, keys]) => keys)).toEqual([
      firstKeys,
      ['action-0'],
      firstKeys,
      ['action-0'],
    ]);
  });

  it('skips a fenced ambiguous member job before deriving or resolving its apparent parent', async () => {
    const helper = jest.spyOn(cleanupProof, 'sourceAbandonmentCleanupParentKey');
    try {
      const data = action({
        actionType: 'BAN_MEMBER',
        messageId: undefined,
        sendAutoDelete: { sourceMessageId: null, sourceSendJobId: 'unread-parent' },
      }).data;
      const resolver = jest.fn<
        ReturnType<SourceAbandonmentRedisResolver>,
        Parameters<SourceAbandonmentRedisResolver>
      >(async (_kind, keys) => ({
        rows: keys.map((key) => ({
          key,
          row: {
            jobId: key,
            ...source,
            messageId: null,
            actionType: 'BAN_MEMBER',
            status: 'IN_PROGRESS',
            ambiguous: false,
            terminal: false,
          },
          digest: 'f'.repeat(64),
        })),
        cost: { pages: 2, rows: 1, probes: 2, bytes: 128 },
        plans: [],
        issue: null,
      }));
      const result = await inventorySourceAbandonmentRedis(
        actionPagesFixture([data]),
        selection,
        [source],
        allowance(),
        resolver,
        'nonce',
      );
      expect(result.issues).toEqual([]);
      expect(result.children).toEqual([]);
      expect(resolver.mock.calls.map(([, keys]) => keys)).toEqual([['action-1']]);
      expect(helper).not.toHaveBeenCalled();
    } finally {
      helper.mockRestore();
    }
  });

  it('reserves probes before issuing Redis work', async () => {
    const redis = redisFixture();
    const result = await inventorySourceAbandonmentRedis(
      redis,
      selection,
      [source],
      { ...allowance(), probes: 1 },
      resolve,
      'nonce',
    );
    expect(result.issues[0]?.code).toBe('REDIS_BUDGET_EXCEEDED');
    expect(redis.eval_ro).not.toHaveBeenCalled();
  });

  it('completes sparse namespace pages without spending the finite effect proof budget', async () => {
    const base = redisFixture();
    let pages = 0;
    const redis = measuredFixture({
      eval_ro: jest.fn(async (script: string, keyCount: number, ...args: string[]) => {
        if (script.startsWith('-- source-abandonment:namespace-catalog-v2')) {
          expect(args[1]).toBe('1');
          pages += 1;
          const cursor = pages === 600 ? '0' : String(pages);
          return [1, 9_212_720, cursor, 0, 0, 100, [], [cursor]];
        }
        return base.eval_ro(script, keyCount, ...args);
      }),
    });
    const result = await inventorySourceAbandonmentRedis(
      redis,
      selection,
      [source],
      allowance(),
      resolve,
      'nonce',
    );
    expect(result.issues).toEqual([]);
    expect(result.catalog).toMatchObject({ complete: true, cost: { pages: 600 } });
    expect(
      redis.eval_ro.mock.calls.filter(([script]) =>
        script.startsWith('-- source-abandonment:namespace-catalog-v2'),
      ),
    ).toHaveLength(600);
    expect(result.catalog?.cost.measurementBytes).toBe(
      600 * (Buffer.byteLength(commandstats()) + Buffer.byteLength(commandstats(12, 200))),
    );
    expect(result.cost.pages).toBeLessThan(100);
    expect(result.cost.probes).toBeLessThan(50_000);
  });

  it.each([
    { reply: [0, 'CATALOG_DATABASE_LIMIT'], code: 'CATALOG_DATABASE_LIMIT' },
    { reply: [0, 'CATALOG_CALL_LATENCY_LIMIT'], code: 'CATALOG_CALL_LATENCY_LIMIT' },
    { reply: [1, 10, '0', 2, 50, 1, [['moderation', 1]]], code: 'CATALOG_ACCOUNTING_UNPROVED' },
    { reply: [1, 10, '0', 1, 50, 1, [['unknown', 1]]], code: 'CATALOG_NAMESPACE_UNPROVED' },
  ])('refuses incomplete structural proof: $code', async ({ reply, code }) => {
    const result = await inventorySourceAbandonmentNamespaces(
      measuredFixture({ eval_ro: jest.fn(async () => reply) }),
      Date.now() + 30_000,
    );
    expect(result).toMatchObject({ complete: false, issue: code });
  });

  it('refuses a repeated cursor and retains the common SQL/job deadline', async () => {
    const redis = measuredFixture({ eval_ro: jest.fn(async () => [1, 100, '12', 0, 0, 1, []]) });
    expect(await inventorySourceAbandonmentNamespaces(redis, Date.now() + 30_000)).toMatchObject({
      complete: false,
      issue: 'CATALOG_CURSOR_REPEAT',
    });
    expect(redis.eval_ro).toHaveBeenCalledTimes(2);
    redis.eval_ro.mockClear();
    expect(await inventorySourceAbandonmentNamespaces(redis, Date.now() - 1)).toMatchObject({
      complete: false,
      issue: 'CATALOG_DEADLINE_EXCEEDED',
    });
    expect(redis.eval_ro).not.toHaveBeenCalled();
  });

  it('refuses an unfinished catalog when its deadline expires during the page yield', async () => {
    let now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const redis = measuredFixture({
      eval_ro: jest.fn(async () => {
        setImmediate(() => {
          now += 20_000;
        });
        return [1, 100, '12', 0, 0, 1, []];
      }),
    });
    try {
      expect(await inventorySourceAbandonmentNamespaces(redis, now + 45_000)).toMatchObject({
        complete: false,
        issue: 'CATALOG_DEADLINE_EXCEEDED',
        cost: { pages: 1, durationMs: 20_000 },
      });
      expect(redis.eval_ro).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it('verifies both bounded catalog artifacts rather than trusting their completion labels', async () => {
    const proof = await inventorySourceAbandonmentNamespaces(
      measuredFixture({
        eval_ro: jest.fn(async () => [1, 1, '0', 1, 32, 1, [['moderation', 1]]]),
      }),
      Date.now() + 30_000,
    );
    expect(() => assertSourceAbandonmentCatalogProofs([proof, proof])).not.toThrow();
    const invalid = [
      { ...proof, complete: false },
      { ...proof, issue: 'UNKNOWN_QUEUE_NAMESPACE' },
      { ...proof, namespaceKeyCounts: { unknown: 1 } },
      { ...proof, namespaceKeyCounts: { moderation: NaN } },
      { ...proof, namespaceKeyCounts: { moderation: -1 } },
      { ...proof, cost: { ...proof.cost, pages: 4097 } },
      { ...proof, cost: { ...proof.cost, scanCountHints: 0 } },
      { ...proof, cost: { ...proof.cost, matchedKeys: 300_001 } },
      { ...proof, cost: { ...proof.cost, databaseKeysMax: 12_000_001 } },
      { ...proof, cost: { ...proof.cost, durationMs: 20_001 } },
      { ...proof, cost: { ...proof.cost, maxCallDurationUs: 50_001 } },
      { ...proof, cost: { ...proof.cost, measurementBytes: 16 * 1024 * 1024 + 1 } },
      { ...proof, cost: { ...proof.cost, measurementBytes: 0 } },
      {
        ...proof,
        cost: Object.fromEntries(
          Object.entries(proof.cost).filter(([key]) => key !== 'measurementBytes'),
        ),
      },
      { ...proof, cost: { ...proof.cost, bytes: Infinity } },
      { ...proof, cost: { ...proof.cost, keyBytes: 64 * 1024 * 1024 + 1 } },
      { ...proof, namespaceKeyCounts: { moderation: 2 }, cost: { ...proof.cost, matchedKeys: 2 } },
      { ...proof, extra: true },
    ];
    for (const other of invalid)
      expect(() => assertSourceAbandonmentCatalogProofs([proof, other])).toThrow('catalog proof');
    expect(() => assertSourceAbandonmentCatalogProofs([proof])).toThrow('catalog proof');
  });
});
