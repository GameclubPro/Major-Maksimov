import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import type Redis from 'ioredis';
import { createCommercialLlmRedis } from '../moderation/commercial/commercial-llm-shadow.lease';
import { CommercialLlmWorkstationMailbox } from '../moderation/commercial/commercial-llm-workstation.mailbox';
import { CommercialLlmPoolMailbox } from '../moderation/commercial/commercial-llm-pool.mailbox';
import {
  buildCommercialLlmRequest,
  COMMERCIAL_LLM_PREVIOUS_PROMPT_SHA256,
  COMMERCIAL_LLM_SYSTEM_PROMPT,
} from '../moderation/commercial/commercial-llm.protocol';
import {
  COMMERCIAL_LLM_POOL_PROFILES,
  commercialLlmPoolJobKey,
  commercialLlmPoolNodeKeys,
  type CommercialLlmPoolBridgeNodeId,
} from '../moderation/commercial/commercial-llm-pool.protocol';
import {
  COMMERCIAL_LLM_PRIMARY_TIMEOUT_MS,
  COMMERCIAL_LLM_WORKSTATION_IDENTITY as identity,
  COMMERCIAL_LLM_WORKSTATION_KEYS as keys,
} from '../moderation/commercial/commercial-llm-workstation.protocol';
const url = process.env.MAXIM_TEST_REDIS_URL ?? '';
(url ? describe : describe.skip)('SSH workstation bridge process with real Redis', () => {
  let redis: Redis, child: ChildProcessWithoutNullStreams | undefined;
  let frames: Record<string, unknown>[];
  let closed: Promise<unknown>;
  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
      throw new Error('disposable Redis required');
    redis = createCommercialLlmRedis(url);
    await redis.connect();
  });
  beforeEach(async () => {
    await redis.del(...Object.values(keys));
    frames = [];
  });
  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      await closed;
    }
    child = undefined;
    await redis.del(...Object.values(keys));
  });
  afterAll(() => redis.disconnect());
  function launch() {
    child = spawn(
      process.execPath,
      ['--import', 'tsx', resolve('src/scripts/commercial-llm-workstation-bridge.ts')],
      {
        env: {
          PATH: process.env.PATH,
          REDIS_URL: url,
          APP_SERVICE_NAME: 'api-moderation-background',
          COMMERCIAL_LLM_SHADOW_ENABLED: 'true',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    closed = once(child, 'close');
    let pending = '';
    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString();
      let at;
      while ((at = pending.indexOf('\n')) >= 0) {
        frames.push(JSON.parse(pending.slice(0, at)));
        pending = pending.slice(at + 1);
      }
    });
    child.stderr.resume();
    return child;
  }
  async function waitFor<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      const value = await read();
      if (accepts(value)) return value;
      await pause(10);
    }
    throw new Error('bridge_test_deadline');
  }
  it('handshakes, classifies one sanitized request and releases owned state on EOF', async () => {
    launch().stdin.write(JSON.stringify({ type: 'hello', identity }) + '\n');
    await waitFor(
      async () => frames,
      (value) => value.some((x) => x.type === 'hello'),
    );
    child!.stdin.write(JSON.stringify({ type: 'ready', ready: true }) + '\n');
    await waitFor(() => redis.get(keys.heartbeat), Boolean);
    const mailbox = new CommercialLlmWorkstationMailbox(redis);
    const result = mailbox.classify('Продам свой старый холодильник');
    await waitFor(
      async () => frames,
      (value) => value.some((x) => x.type === 'request'),
    );
    const request = frames.find((x) => x.type === 'request')!;
    child!.stdin.write(
      JSON.stringify({
        type: 'response',
        id: request.id,
        body: JSON.stringify({
          model: identity.modelAlias,
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
      }) + '\n',
    );
    expect(await result).toMatchObject({
      outcome: 'COMPLETE',
      result: { modelAlias: identity.modelAlias },
    });
    child!.stdin.end();
    await closed;
    expect(await redis.exists(...Object.values(keys))).toBe(0);
  });
  it('accepts the control frames for thirty starts and periodic readiness in one minute', async () => {
    launch().stdin.write(JSON.stringify({ type: 'hello', identity }) + '\n');
    await waitFor(
      async () => frames,
      (value) => value.some((x) => x.type === 'hello'),
    );
    const responseBody = JSON.stringify({
      model: identity.modelAlias,
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: '{"classification":"NOT_COMMERCIAL","reasonCodes":["PERSONAL_SALE"]}',
          },
        },
      ],
    });
    const ready = { type: 'ready', ready: true };
    // FLAG: Replay the one-minute envelope as a bounded batch: forty periodic heartbeats
    // plus three frames per completed start. Expired response IDs never regain authority.
    const minute = [
      ...Array.from({ length: 40 }, () => ready),
      ...Array.from({ length: 30 }, () => [
        { type: 'ready', ready: false },
        { type: 'response', id: randomUUID(), body: responseBody },
        ready,
      ]).flat(),
    ];
    expect(minute).toHaveLength(130);
    child!.stdin.write(minute.map((frame) => JSON.stringify(frame) + '\n').join(''));
    await waitFor(() => redis.get(keys.heartbeat), Boolean);
    expect(await redis.exists(keys.request, keys.response)).toBe(0);
    const result = new CommercialLlmWorkstationMailbox(redis).classify(
      'Продам свой старый холодильник',
    );
    await waitFor(
      async () => frames,
      (value) => value.some((x) => x.type === 'request'),
    );
    const request = frames.find((x) => x.type === 'request')!;
    child!.stdin.write(
      JSON.stringify({ type: 'response', id: request.id, body: responseBody }) + '\n',
    );
    expect(await result).toMatchObject({
      outcome: 'COMPLETE',
      result: { modelAlias: identity.modelAlias },
    });
    expect(child!.exitCode).toBeNull();
  });
  it('ends a session that exceeds the bounded control-frame budget', async () => {
    launch().stdin.write(JSON.stringify({ type: 'hello', identity }) + '\n');
    await waitFor(
      async () => frames,
      (value) => value.some((x) => x.type === 'hello'),
    );
    child!.stdin.write(
      Array.from({ length: 160 }, () => JSON.stringify({ type: 'ready', ready: true }) + '\n').join(
        '',
      ),
    );
    await closed;
    expect(await redis.exists(...Object.values(keys))).toBe(0);
  });
  it.each(['foreign', 'oversized', 'malformed'])(
    'ends a %s session and never advertises it as ready',
    async (kind) => {
      launch();
      child!.stdin.write(
        kind === 'foreign'
          ? JSON.stringify({ type: 'hello', identity: { ...identity, modelSha256: 'foreign' } }) +
              '\n'
          : kind === 'oversized'
            ? 'x'.repeat(65537)
            : 'bad-json\n',
      );
      await closed;
      expect(await redis.exists(...Object.values(keys))).toBe(0);
      expect(frames).toEqual([]);
    },
  );
});

(url ? describe : describe.skip)('existing first-PC v1 worker in the independent pool', () => {
  let redis: Redis;
  const children: Array<{
    child: ChildProcessWithoutNullStreams;
    closed: Promise<unknown>;
    frames: Record<string, unknown>[];
  }> = [];
  const jobs = new Set<string>();
  const firstKeys = commercialLlmPoolNodeKeys('pc-a-4b');
  const secondKeys = commercialLlmPoolNodeKeys('pc-b-9b');
  const stateKeys = [
    ...Object.values(keys),
    ...Object.values(firstKeys),
    ...Object.values(secondKeys),
  ];
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
      throw new Error('disposable loopback Redis required');
    redis = createCommercialLlmRedis(url);
    await redis.connect();
  });
  beforeEach(async () => {
    await redis.del(...stateKeys, ...jobs);
    jobs.clear();
  });
  afterEach(async () => {
    for (const { child } of children)
      if (child.exitCode === null && child.signalCode === null) child.stdin.end();
    await Promise.all(children.map(({ closed }) => closed));
    children.length = 0;
    await redis.del(...stateKeys, ...jobs);
  });
  afterAll(() => redis.disconnect());

  function launch(
    nodeId?: CommercialLlmPoolBridgeNodeId,
    environment: Record<string, string> = {},
  ) {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve(
          nodeId
            ? 'src/scripts/commercial-llm-pool-bridge.ts'
            : 'src/scripts/commercial-llm-workstation-bridge.ts',
        ),
        ...(nodeId ? [nodeId] : []),
      ],
      {
        env: {
          PATH: process.env.PATH,
          REDIS_URL: url,
          APP_SERVICE_NAME: 'api-moderation-background',
          COMMERCIAL_LLM_POOL_ENABLED: 'true',
          COMMERCIAL_LLM_POOL_WORKERS_ENABLED: 'true',
          // The compatible pool path is independent from the retired legacy SHADOW flag.
          COMMERCIAL_LLM_SHADOW_ENABLED: 'false',
          ...environment,
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
  }
  async function waitFor<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const value = await read();
      if (accepts(value)) return value;
      await pause(10);
    }
    throw new Error('compatible_bridge_test_deadline');
  }
  const send = (state: ReturnType<typeof launch>, frame: unknown) =>
    state.child.stdin.write(JSON.stringify(frame) + '\n');
  async function connected(nodeId?: CommercialLlmPoolBridgeNodeId, previousPrompt = false) {
    const state = launch(nodeId);
    send(
      state,
      nodeId
        ? { type: 'hello', nodeId, identity: COMMERCIAL_LLM_POOL_PROFILES[nodeId].identity }
        : {
            type: 'hello',
            identity: {
              ...identity,
              ...(previousPrompt ? { promptSha256: COMMERCIAL_LLM_PREVIOUS_PROMPT_SHA256 } : {}),
            },
          },
    );
    await waitFor(
      async () => state.frames,
      (frames) => frames.some((frame) => frame.type === 'hello'),
    );
    send(state, { type: 'ready', ready: true });
    const selected = nodeId ?? 'pc-a-4b';
    await waitFor(
      () => new CommercialLlmPoolMailbox(redis).available(),
      (available) => available.includes(selected),
    );
    return state;
  }
  async function reserve(nodeId: CommercialLlmPoolBridgeNodeId) {
    const jobId = randomUUID();
    jobs.add(commercialLlmPoolJobKey(jobId));
    const reservation = await new CommercialLlmPoolMailbox(redis).reserve(nodeId, {
      jobId,
      attempt: 1,
      deadlineAtMs: Date.now() + 5000,
      body: JSON.stringify({
        ...buildCommercialLlmRequest('Продам свой старый холодильник'),
        model: COMMERCIAL_LLM_POOL_PROFILES[nodeId].identity.modelAlias,
      }),
    });
    expect(reservation).not.toBeNull();
    return reservation!;
  }
  async function requestFrame(state: ReturnType<typeof launch>) {
    await waitFor(
      async () => state.frames,
      (frames) => frames.some((frame) => frame.type === 'request'),
    );
    return state.frames.find((frame) => frame.type === 'request')!;
  }
  const responseBody = (nodeId: CommercialLlmPoolBridgeNodeId) =>
    JSON.stringify({
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
    });

  it('preserves the exact v1 handshake and raw request/response while using only the fixed pool slot', async () => {
    const state = await connected();
    expect(state.frames[0]).toEqual({ type: 'hello', identity });
    expect(await redis.exists(...Object.values(keys))).toBe(0);
    expect(JSON.parse((await redis.get(firstKeys.heartbeat))!).identity).toEqual(
      COMMERCIAL_LLM_POOL_PROFILES['pc-a-4b'].identity,
    );
    const reservation = await reserve('pc-a-4b');
    const frame = await requestFrame(state);
    expect(frame).toEqual({
      type: 'request',
      id: reservation.id,
      body: reservation.body,
      timeoutMs: COMMERCIAL_LLM_PRIMARY_TIMEOUT_MS,
    });
    const body = responseBody('pc-a-4b');
    send(state, { type: 'response', id: reservation.id, body });
    expect(await new CommercialLlmPoolMailbox(redis).wait(reservation)).toEqual({
      outcome: 'COMPLETE',
      body,
    });
    state.child.stdin.end();
    await state.closed;
    expect(await redis.exists(...stateKeys)).toBe(0);
  });

  it('retains the deployed v1 hello while forwarding the new category prompt into the pool', async () => {
    const state = await connected(undefined, true);
    expect(state.frames[0]).toEqual({
      type: 'hello',
      identity: { ...identity, promptSha256: COMMERCIAL_LLM_PREVIOUS_PROMPT_SHA256 },
    });
    const reservation = await reserve('pc-a-4b');
    const frame = await requestFrame(state);
    expect(JSON.parse(String(frame.body)).messages[0].content).toBe(COMMERCIAL_LLM_SYSTEM_PROMPT);
    expect(JSON.parse((await redis.get(firstKeys.heartbeat))!).identity).toEqual(
      COMMERCIAL_LLM_POOL_PROFILES['pc-a-4b'].identity,
    );
    const body = responseBody('pc-a-4b');
    send(state, { type: 'response', id: reservation.id, body });
    expect(await new CommercialLlmPoolMailbox(redis).wait(reservation)).toEqual({
      outcome: 'COMPLETE',
      body,
    });
  });

  it('runs the unchanged first-PC wire beside the second-PC v2 worker without a shared slot', async () => {
    const [first, second] = await Promise.all([connected(), connected('pc-b-9b')]);
    const reservations = await Promise.all([reserve('pc-a-4b'), reserve('pc-b-9b')]);
    const requests = await Promise.all([requestFrame(first), requestFrame(second)]);
    expect(requests.map((frame) => frame.id)).toEqual(reservations.map((request) => request.id));
    expect(Number(requests[0].timeoutMs)).toBeLessThanOrEqual(COMMERCIAL_LLM_PRIMARY_TIMEOUT_MS);
    expect(Number(requests[1].timeoutMs)).toBeGreaterThan(COMMERCIAL_LLM_PRIMARY_TIMEOUT_MS);
    for (const [index, state] of [first, second].entries())
      send(state, {
        type: 'response',
        id: reservations[index].id,
        body: responseBody(reservations[index].nodeId as CommercialLlmPoolBridgeNodeId),
      });
    const mailbox = new CommercialLlmPoolMailbox(redis);
    expect(
      (await Promise.all(reservations.map((reservation) => mailbox.wait(reservation)))).map(
        (outcome) => outcome.outcome,
      ),
    ).toEqual(['COMPLETE', 'COMPLETE']);
  });

  it.each(['foreign-pins', 'caller-selected-node'] as const)(
    'rejects %s without advertising either mailbox',
    async (kind) => {
      const state = launch();
      send(
        state,
        kind === 'foreign-pins'
          ? { type: 'hello', identity: { ...identity, modelSha256: 'wrong' } }
          : { type: 'hello', identity, nodeId: 'pc-b-9b' },
      );
      await state.closed;
      expect(state.frames).toEqual([]);
      expect(await redis.exists(...stateKeys)).toBe(0);
    },
  );

  it.each(['false', ''] as const)(
    'refuses enabled pool with workers flag %j instead of silently using legacy routing',
    async (enabled) => {
      const state = launch(undefined, {
        COMMERCIAL_LLM_POOL_WORKERS_ENABLED: enabled,
        COMMERCIAL_LLM_SHADOW_ENABLED: 'true',
      });
      await state.closed;
      expect(state.frames).toEqual([]);
      expect(await redis.exists(...stateKeys)).toBe(0);
    },
  );

  it('keeps the first PC on the legacy mailbox during workers-only preflight', async () => {
    const state = launch(undefined, {
      COMMERCIAL_LLM_POOL_ENABLED: 'false',
      COMMERCIAL_LLM_SHADOW_ENABLED: 'true',
    });
    send(state, { type: 'hello', identity });
    await waitFor(
      async () => state.frames,
      (frames) => frames.some((frame) => frame.type === 'hello'),
    );
    send(state, { type: 'ready', ready: true });
    await waitFor(() => redis.get(keys.heartbeat), Boolean);
    expect(await redis.exists(firstKeys.lease, firstKeys.heartbeat)).toBe(0);
    expect(state.frames[0]).toEqual({ type: 'hello', identity });
  });

  it('a v2 first-PC worker cannot duplicate the compatible v1 worker’s physical lease', async () => {
    const first = await connected();
    const lease = await redis.get(firstKeys.lease);
    const duplicate = launch('pc-a-4b');
    send(duplicate, {
      type: 'hello',
      nodeId: 'pc-a-4b',
      identity: COMMERCIAL_LLM_POOL_PROFILES['pc-a-4b'].identity,
    });
    await duplicate.closed;
    expect(duplicate.frames).toEqual([]);
    expect(first.child.exitCode).toBeNull();
    expect(await redis.get(firstKeys.lease)).toBe(lease);
    expect(await new CommercialLlmPoolMailbox(redis).available()).toContain('pc-a-4b');
  });

  it('does not renew a silent handshake or let its delayed hello clear a replacement session', async () => {
    const stale = launch();
    await waitFor(() => redis.get(firstKeys.lease), Boolean);
    expect(await redis.get(firstKeys.heartbeat)).toBeNull();
    await redis.pexpire(firstKeys.lease, 20);
    await pause(350);
    expect(await redis.exists(firstKeys.lease, firstKeys.heartbeat)).toBe(0);
    const replacement = await connected();
    const owner = await redis.get(firstKeys.lease);
    send(stale, { type: 'hello', identity });
    await stale.closed;
    expect(replacement.child.exitCode).toBeNull();
    expect(await redis.get(firstKeys.lease)).toBe(owner);
    expect(await new CommercialLlmPoolMailbox(redis).available()).toContain('pc-a-4b');
  });

  it('ends a failed v1 computation without fabricating a null response or disturbing the second PC', async () => {
    const first = await connected();
    const second = await connected('pc-b-9b');
    const reservation = await reserve('pc-a-4b');
    await requestFrame(first);
    send(first, { type: 'failed', id: reservation.id });
    await first.closed;
    const mailbox = new CommercialLlmPoolMailbox(redis);
    expect(await mailbox.wait(reservation)).toEqual({ outcome: 'UNAVAILABLE' });
    expect(await redis.get(firstKeys.response)).toBeNull();
    expect(await redis.exists(...Object.values(keys))).toBe(0);
    expect(second.child.exitCode).toBeNull();
    expect(await mailbox.available()).toContain('pc-b-9b');
  });

  it('uses the pool’s bounded 512-frame budget without retaining a flooded worker', async () => {
    const state = await connected();
    const ready = JSON.stringify({ type: 'ready', ready: true }) + '\n';
    state.child.stdin.write(ready.repeat(200));
    const reservation = await reserve('pc-a-4b');
    await requestFrame(state);
    send(state, { type: 'response', id: reservation.id, body: responseBody('pc-a-4b') });
    expect((await new CommercialLlmPoolMailbox(redis).wait(reservation)).outcome).toBe('COMPLETE');
    state.child.stdin.write(ready.repeat(400));
    await state.closed;
    expect(await redis.exists(...stateKeys)).toBe(0);
  });
});
