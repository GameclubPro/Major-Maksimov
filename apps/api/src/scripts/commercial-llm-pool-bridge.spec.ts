import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import type Redis from 'ioredis';
import { createCommercialLlmRedis } from '../moderation/commercial/commercial-llm-shadow.lease';
import { CommercialLlmPoolMailbox } from '../moderation/commercial/commercial-llm-pool.mailbox';
import {
  buildCommercialLlmRequest,
  COMMERCIAL_LLM_PREVIOUS_PROMPT_SHA256,
  COMMERCIAL_LLM_SYSTEM_PROMPT,
} from '../moderation/commercial/commercial-llm.protocol';
import {
  COMMERCIAL_LLM_POOL_FRAMES_PER_MINUTE,
  COMMERCIAL_LLM_POOL_PROFILES,
  POOL_NODE_IDS,
  POOL_PENDING_KEYS,
  commercialLlmPoolNodeKeys,
  commercialLlmPoolJobKey,
  type CommercialLlmPoolBridgeNodeId,
} from '../moderation/commercial/commercial-llm-pool.protocol';

const url = process.env.MAXIM_TEST_REDIS_URL ?? '';
(url ? describe : describe.skip)('fixed-node pool bridge with real Redis and processes', () => {
  let redis: Redis;
  const children: Array<{
    child: ChildProcessWithoutNullStreams;
    closed: Promise<unknown>;
    frames: Record<string, unknown>[];
  }> = [];
  const jobs = new Set<string>();
  const nodeKeys = POOL_NODE_IDS.flatMap((id) => Object.values(commercialLlmPoolNodeKeys(id)));
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
      throw new Error('disposable loopback Redis required');
    redis = createCommercialLlmRedis(url);
    await redis.connect();
  });
  beforeEach(async () => {
    await redis.del(...nodeKeys, ...POOL_PENDING_KEYS, ...jobs);
    jobs.clear();
  });
  afterEach(async () => {
    for (const { child } of children)
      if (child.exitCode === null && child.signalCode === null) child.stdin.end();
    await Promise.all(children.map(({ closed }) => closed));
    children.length = 0;
    await redis.del(...nodeKeys, ...POOL_PENDING_KEYS, ...jobs);
  });
  afterAll(() => redis.disconnect());
  const launch = (nodeId: string, enabled = 'true') => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', resolve('src/scripts/commercial-llm-pool-bridge.ts'), nodeId],
      {
        env: {
          PATH: process.env.PATH,
          REDIS_URL: url,
          APP_SERVICE_NAME: 'api-moderation-background',
          COMMERCIAL_LLM_POOL_WORKERS_ENABLED: enabled,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const state = { child, closed: once(child, 'close'), frames: [] as Record<string, unknown>[] };
    children.push(state);
    let pending = '';
    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString();
      let at: number;
      while ((at = pending.indexOf('\n')) >= 0) {
        state.frames.push(JSON.parse(pending.slice(0, at)));
        pending = pending.slice(at + 1);
      }
    });
    child.stderr.resume();
    return state;
  };
  const waitFor = async <T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const value = await read();
      if (accepts(value)) return value;
      await pause(10);
    }
    throw new Error('pool_bridge_test_deadline');
  };
  const connected = async (nodeId: CommercialLlmPoolBridgeNodeId, previousPrompt = false) => {
    const state = launch(nodeId);
    state.child.stdin.write(
      JSON.stringify({
        type: 'hello',
        nodeId,
        identity: {
          ...COMMERCIAL_LLM_POOL_PROFILES[nodeId].identity,
          ...(previousPrompt ? { promptSha256: COMMERCIAL_LLM_PREVIOUS_PROMPT_SHA256 } : {}),
        },
      }) + '\n',
    );
    await waitFor(
      async () => state.frames,
      (frames) => frames.some((frame) => frame.type === 'hello'),
    );
    state.child.stdin.write(JSON.stringify({ type: 'ready', ready: true }) + '\n');
    await waitFor(() => redis.get(commercialLlmPoolNodeKeys(nodeId).heartbeat), Boolean);
    return state;
  };
  const reserve = async (nodeId: CommercialLlmPoolBridgeNodeId) => {
    const jobId = randomUUID();
    jobs.add(commercialLlmPoolJobKey(jobId));
    const value = await new CommercialLlmPoolMailbox(redis).reserve(nodeId, {
      jobId,
      attempt: 1,
      deadlineAtMs: Date.now() + 4000,
      body: JSON.stringify({
        ...buildCommercialLlmRequest('Продам свой старый холодильник'),
        model: COMMERCIAL_LLM_POOL_PROFILES[nodeId].identity.modelAlias,
      }),
    });
    expect(value).not.toBeNull();
    return value!;
  };
  const answer = (nodeId: CommercialLlmPoolBridgeNodeId, id: unknown) => ({
    type: 'response',
    id,
    body: JSON.stringify({
      model: COMMERCIAL_LLM_POOL_PROFILES[nodeId].identity.modelAlias,
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: '{"classification":"NOT_COMMERCIAL","reasonCodes":["PERSONAL_SALE"]}',
          },
        },
      ],
    }),
  });

  it('connects both fixed PC identities and completes independent concurrent requests', async () => {
    const [a, b] = await Promise.all([connected('pc-a-4b'), connected('pc-b-9b')]);
    expect(a.frames[0]).toEqual({
      type: 'hello',
      nodeId: 'pc-a-4b',
      identity: COMMERCIAL_LLM_POOL_PROFILES['pc-a-4b'].identity,
    });
    const [first, second] = await Promise.all([reserve('pc-a-4b'), reserve('pc-b-9b')]);
    await Promise.all(
      [a, b].map((state) =>
        waitFor(
          async () => state.frames,
          (frames) => frames.some((frame) => frame.type === 'request'),
        ),
      ),
    );
    const firstFrame = a.frames.find((frame) => frame.type === 'request')!;
    const secondFrame = b.frames.find((frame) => frame.type === 'request')!;
    expect(firstFrame.id).toBe(first.id);
    expect(secondFrame.id).toBe(second.id);
    expect(Number(firstFrame.timeoutMs)).toBeLessThanOrEqual(20_000);
    a.child.stdin.write(JSON.stringify({ type: 'ready', ready: false }) + '\n');
    b.child.stdin.write(JSON.stringify({ type: 'ready', ready: false }) + '\n');
    a.child.stdin.write(JSON.stringify(answer('pc-a-4b', first.id)) + '\n');
    b.child.stdin.write(JSON.stringify(answer('pc-b-9b', second.id)) + '\n');
    const mailbox = new CommercialLlmPoolMailbox(redis);
    expect(
      (await Promise.all([mailbox.wait(first), mailbox.wait(second)])).map((r) => r.outcome),
    ).toEqual(['COMPLETE', 'COMPLETE']);
  });

  it.each(['pc-a-4b', 'pc-b-9b'] as const)(
    'forwards the current prompt to reviewed previous %s workers',
    async (nodeId) => {
      const state = await connected(nodeId, true);
      expect(state.frames[0]).toMatchObject({
        identity: { promptSha256: COMMERCIAL_LLM_PREVIOUS_PROMPT_SHA256 },
      });
      expect(
        JSON.parse((await redis.get(commercialLlmPoolNodeKeys(nodeId).heartbeat))!).identity,
      ).toEqual(COMMERCIAL_LLM_POOL_PROFILES[nodeId].identity);
      const reservation = await reserve(nodeId);
      await waitFor(
        async () => state.frames,
        (frames) => frames.some((frame) => frame.type === 'request'),
      );
      const frame = state.frames.find((entry) => entry.type === 'request')!;
      expect(JSON.parse(String(frame.body)).messages[0].content).toBe(COMMERCIAL_LLM_SYSTEM_PROMPT);
      const reply = answer(nodeId, reservation.id);
      const body = JSON.parse(reply.body);
      body.choices[0].message.content = JSON.stringify({
        classification: 'COMMERCIAL',
        reasonCodes: ['SERVICE_OFFER', 'BUSINESS_OFFER'],
      });
      reply.body = JSON.stringify(body);
      state.child.stdin.write(JSON.stringify(reply) + '\n');
      expect(await new CommercialLlmPoolMailbox(redis).wait(reservation)).toEqual({
        outcome: 'COMPLETE',
        body: reply.body,
      });
    },
  );

  it('EOF removes only its own session and fences in-flight replies while another PC remains ready', async () => {
    const a = await connected('pc-a-4b');
    await connected('pc-b-9b');
    const value = await reserve('pc-a-4b');
    a.child.stdin.end();
    await a.closed;
    const mailbox = new CommercialLlmPoolMailbox(redis);
    expect(await mailbox.wait(value)).toEqual({ outcome: 'UNAVAILABLE' });
    expect(await mailbox.available()).toEqual(['pc-b-9b']);
    expect(
      await mailbox.respond(
        value.nodeId,
        value.session,
        value.id,
        answer('pc-a-4b', value.id).body,
      ),
    ).toBe(false);
  });

  it('does not let hello impersonate another PC even with that model’s valid pins', async () => {
    const state = launch('pc-a-4b');
    state.child.stdin.write(
      JSON.stringify({
        type: 'hello',
        nodeId: 'pc-b-9b',
        identity: COMMERCIAL_LLM_POOL_PROFILES['pc-b-9b'].identity,
      }) + '\n',
    );
    await state.closed;
    expect(state.frames).toEqual([]);
    expect(await redis.exists(...nodeKeys)).toBe(0);
  });

  it.each(['server-9b', 'foreign-node'])(
    'refuses untrusted bridge target %s before advertising capacity',
    async (nodeId) => {
      const state = launch(nodeId);
      await state.closed;
      expect(state.frames).toEqual([]);
      expect(await redis.exists(...nodeKeys)).toBe(0);
    },
  );

  it('keeps the new bridge disabled unless the worker preflight flag is enabled', async () => {
    const state = launch('pc-b-9b', 'false');
    await state.closed;
    expect(await redis.exists(...nodeKeys)).toBe(0);
  });

  it('isolates each session rate budget and preserves peer capacity after a flood', async () => {
    const a = await connected('pc-a-4b');
    const b = await connected('pc-b-9b');
    a.child.stdin.write(
      Array.from(
        { length: COMMERCIAL_LLM_POOL_FRAMES_PER_MINUTE },
        () => JSON.stringify({ type: 'ready', ready: true }) + '\n',
      ).join(''),
    );
    await a.closed;
    expect(b.child.exitCode).toBeNull();
    expect(await new CommercialLlmPoolMailbox(redis).available()).toEqual(['pc-b-9b']);
  });

  it.each(['malformed', 'oversized', 'failed-frame', 'foreign-runtime'])(
    'ends a %s session without recording a model result',
    async (kind) => {
      const state = launch('pc-b-9b');
      if (kind === 'foreign-runtime') {
        state.child.stdin.write(
          JSON.stringify({
            type: 'hello',
            nodeId: 'pc-b-9b',
            identity: {
              ...COMMERCIAL_LLM_POOL_PROFILES['pc-b-9b'].identity,
              runtimeImageSha256: 'forged-docker',
            },
          }) + '\n',
        );
      } else if (kind === 'oversized') state.child.stdin.write('x'.repeat(65537));
      else if (kind === 'malformed') state.child.stdin.write('not-json\n');
      else state.child.stdin.write(JSON.stringify({ type: 'failed', id: randomUUID() }) + '\n');
      await state.closed;
      expect(state.frames).toEqual([]);
      expect(await redis.exists(...nodeKeys)).toBe(0);
    },
  );
});
