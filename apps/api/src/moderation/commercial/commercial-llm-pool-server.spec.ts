import { randomUUID } from 'node:crypto';
import { CommercialLlmPoolServer } from './commercial-llm-pool-server';
import {
  CommercialLlmPoolMailbox,
  type CommercialLlmPoolReservation,
} from './commercial-llm-pool.mailbox';
import { CommercialLlmShadowLease, createCommercialLlmRedis } from './commercial-llm-shadow.lease';
import { COMMERCIAL_LLM_POOL_PROFILES } from './commercial-llm-pool.protocol';

jest.mock('./commercial-llm-pool.protocol', () => {
  const actual = jest.requireActual<typeof import('./commercial-llm-pool.protocol')>(
    './commercial-llm-pool.protocol',
  );
  const { createHash } = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return {
    ...actual,
    COMMERCIAL_LLM_POOL_PROFILES: {
      ...actual.COMMERCIAL_LLM_POOL_PROFILES,
      'server-9b': {
        ...actual.COMMERCIAL_LLM_POOL_PROFILES['server-9b'],
        identity: {
          ...actual.COMMERCIAL_LLM_POOL_PROFILES['server-9b'].identity,
          chatTemplateSha256: createHash('sha256').update('fixture template').digest('hex'),
        },
      },
    },
  };
});

const slotResponse = (processing: boolean) =>
  Response.json([{ id: 0, n_ctx: 4096, is_processing: processing }]);

describe('pool server physical capacity containment', () => {
  const redis = createCommercialLlmRedis('redis://127.0.0.1:1');
  let mailbox: CommercialLlmPoolMailbox;
  let server: CommercialLlmPoolServer;
  let fetchImpl: jest.MockedFunction<typeof fetch>;
  let processing: boolean;
  let lease: string | null;
  let session: string;
  let now: number;
  let release: jest.SpyInstance;
  const reply = JSON.stringify({
    model: COMMERCIAL_LLM_POOL_PROFILES['server-9b'].identity.modelAlias,
    choices: [
      {
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: JSON.stringify({
            classification: 'NOT_COMMERCIAL',
            reasonCodes: ['ORDINARY_DISCUSSION'],
          }),
        },
      },
    ],
  });

  beforeEach(async () => {
    now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    processing = false;
    lease = randomUUID();
    jest.spyOn(redis, 'mget').mockImplementation(async () => [null, null]);
    jest.spyOn(CommercialLlmShadowLease.prototype, 'acquire').mockImplementation(async () => lease);
    jest.spyOn(CommercialLlmShadowLease.prototype, 'owns').mockResolvedValue(true);
    jest.spyOn(CommercialLlmShadowLease.prototype, 'retainUntilReleased').mockResolvedValue(true);
    release = jest
      .spyOn(CommercialLlmShadowLease.prototype, 'release')
      .mockResolvedValue(undefined);
    mailbox = new CommercialLlmPoolMailbox(redis);
    jest.spyOn(mailbox, 'acquireWorker').mockImplementation(async (_node, value) => {
      session = value;
      return true;
    });
    jest.spyOn(mailbox, 'refreshWorker').mockResolvedValue(null);
    jest.spyOn(mailbox, 'releaseWorker').mockResolvedValue(undefined);
    jest.spyOn(mailbox, 'releaseUndispatched').mockResolvedValue(true);
    jest.spyOn(mailbox, 'respond').mockResolvedValue(true);
    fetchImpl = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async (_url, init) =>
      init?.method === 'POST'
        ? new Response(reply, { headers: { 'content-type': 'application/json' } })
        : slotResponse(processing),
    );
    server = new CommercialLlmPoolServer(
      redis,
      mailbox,
      'http://127.0.0.1:18084',
      async () => true,
      fetchImpl,
    );
    // FLAG: These tests isolate lifecycle containment; exact identity matching is covered separately.
    jest
      .spyOn(server as unknown as { identityMatches(): Promise<boolean> }, 'identityMatches')
      .mockResolvedValue(true);
    await server.tick();
  });
  afterEach(async () => {
    await server.close();
    jest.restoreAllMocks();
  });
  afterAll(() => redis.disconnect());

  function reservation(): CommercialLlmPoolReservation {
    const id = randomUUID();
    return {
      nodeId: 'server-9b',
      session,
      id,
      attemptId: id,
      jobId: randomUUID(),
      attempt: 1,
      deadlineAtMs: now + 20_000,
      body: '{}',
      raw: '{}',
    };
  }
  it('returns the original bounded envelope and releases capacity after a complete response', async () => {
    const request = reservation();
    await server.dispatch(request);
    expect(mailbox.respond).toHaveBeenCalledWith('server-9b', session, request.id, reply);
    expect(release).toHaveBeenCalledWith(lease);
    expect(mailbox.releaseUndispatched).not.toHaveBeenCalled();
  });
  it.each([
    '{"classification":"COMMERCIAL","reasonCodes":["ORDINARY_DISCUSSION"]}',
    '{"classification":"UNSURE","reasonCodes":["INSUFFICIENT_CONTEXT","INSUFFICIENT_CONTEXT"]}',
    '{"classification":',
  ])(
    'rejects unusable decision without quarantining a completed CPU request %#',
    async (content) => {
      const payload = JSON.parse(reply);
      payload.choices[0].message.content = content;
      fetchImpl.mockResolvedValueOnce(Response.json(payload));
      await expect(server.dispatch(reservation())).rejects.toMatchObject({
        kind: 'INVALID_RESPONSE',
      });
      expect(mailbox.respond).toHaveBeenCalledWith(
        'server-9b',
        session,
        expect.any(String),
        JSON.stringify(payload),
      );
      expect(release).toHaveBeenCalledWith(lease);
      now += 1_001;
      await server.tick();
      expect(mailbox.refreshWorker).toHaveBeenLastCalledWith('server-9b', session, true);
      await server.dispatch(reservation());
      expect(mailbox.respond).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    { model: 'wrong-model' },
    { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{}' } }] },
    { choices: [{ finish_reason: null, message: { role: 'assistant', content: '{}' } }] },
    {
      choices: [
        { finish_reason: 'stop', message: { role: 'assistant', content: '{}', tool_calls: [{}] } },
      ],
    },
  ])('retains physical uncertainty for an unverified completion envelope %#', async (change) => {
    fetchImpl.mockResolvedValueOnce(Response.json({ ...JSON.parse(reply), ...change }));
    await expect(server.dispatch(reservation())).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
    });
    expect(mailbox.respond).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    now += 1_001;
    await server.tick();
    expect(mailbox.refreshWorker).toHaveBeenLastCalledWith('server-9b', session, false);
  });

  it('does not send HTTP or strand capacity when the legacy CPU lease is occupied', async () => {
    lease = null;
    const request = reservation();
    await expect(server.dispatch(request)).rejects.toMatchObject({ kind: 'BUSY' });
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(mailbox.releaseUndispatched).toHaveBeenCalledWith(request);
  });
  it('allows a complete CPU response at the six-second admission boundary', async () => {
    const request = reservation();
    now = request.deadlineAtMs - 6_000;
    await server.dispatch(request);
    expect(mailbox.respond).toHaveBeenCalledWith('server-9b', session, request.id, reply);
    expect(release).toHaveBeenCalledWith(lease);
  });
  it.each(['before admission', 'during headroom check', 'during retention'])(
    'refuses a CPU handoff with insufficient useful budget %s',
    async (stage) => {
      const request = reservation();
      const exhaustBudget = async () => {
        now = request.deadlineAtMs - 25;
        return true;
      };
      if (stage === 'before admission') await exhaustBudget();
      else if (stage === 'during headroom check')
        jest
          .spyOn(server as unknown as { hasHeadroom(): Promise<boolean> }, 'hasHeadroom')
          .mockImplementation(exhaustBudget);
      else
        jest
          .mocked(CommercialLlmShadowLease.prototype.retainUntilReleased)
          .mockImplementation(exhaustBudget);
      await expect(server.dispatch(request)).rejects.toMatchObject({ kind: 'BUSY' });
      expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
      expect(mailbox.releaseUndispatched).toHaveBeenCalledWith(request);
      if (stage !== 'before admission') expect(release).toHaveBeenCalledWith(lease);
    },
  );
  it('holds the lease after an ambiguous transport failure even when the single slot becomes idle', async () => {
    fetchImpl.mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') throw new Error('connection lost');
      return slotResponse(processing);
    });
    await expect(server.dispatch(reservation())).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
    expect(release).not.toHaveBeenCalled();
    expect(mailbox.releaseUndispatched).not.toHaveBeenCalled();
    processing = true;
    now += 1_001;
    await server.tick();
    expect(release).not.toHaveBeenCalled();
    expect(mailbox.refreshWorker).toHaveBeenLastCalledWith('server-9b', session, false);
    processing = false;
    now += 1_001;
    await server.tick();
    expect(release).not.toHaveBeenCalled();
    expect(mailbox.refreshWorker).toHaveBeenLastCalledWith('server-9b', session, false);
    const requestsBeforeRetry = fetchImpl.mock.calls.length;
    await expect(server.dispatch(reservation())).rejects.toMatchObject({ kind: 'BUSY' });
    expect(fetchImpl).toHaveBeenCalledTimes(requestsBeforeRetry);
    expect(
      fetchImpl.mock.calls
        .filter(([, init]) => init?.method !== 'POST')
        .every(([url]) => new URL(String(url)).pathname === '/slots'),
    ).toBe(true);
  });

  it('never sends HTTP after the exact lease cannot be retained', async () => {
    jest.mocked(CommercialLlmShadowLease.prototype.retainUntilReleased).mockResolvedValue(false);
    const request = reservation();
    await expect(server.dispatch(request)).rejects.toMatchObject({ kind: 'BUSY' });
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(mailbox.releaseUndispatched).toHaveBeenCalledWith(request);
    expect(release).toHaveBeenCalledWith(lease);
  });

  it('releases a retained but undispatched lease when cancellation arrives during retention', async () => {
    const controller = new AbortController();
    jest
      .mocked(CommercialLlmShadowLease.prototype.retainUntilReleased)
      .mockImplementation(async () => {
        controller.abort();
        return true;
      });
    const request = reservation();
    await expect(server.dispatch(request, controller.signal)).rejects.toMatchObject({
      kind: 'BUSY',
    });
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(mailbox.releaseUndispatched).toHaveBeenCalledWith(request);
    expect(release).toHaveBeenCalledWith(lease);
  });

  it('rechecks the original deadline after retaining capacity', async () => {
    const request = reservation();
    jest
      .mocked(CommercialLlmShadowLease.prototype.retainUntilReleased)
      .mockImplementation(async () => {
        now = request.deadlineAtMs;
        return true;
      });
    await expect(server.dispatch(request)).rejects.toMatchObject({ kind: 'BUSY' });
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(mailbox.releaseUndispatched).toHaveBeenCalledWith(request);
    expect(release).toHaveBeenCalledWith(lease);
  });

  it('does not publish when source cancellation arrives during the final ownership read', async () => {
    const source = new AbortController();
    jest.mocked(CommercialLlmShadowLease.prototype.owns).mockImplementation(async () => {
      source.abort();
      return true;
    });
    await server.dispatch(reservation(), source.signal);
    expect(mailbox.respond).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(lease);
  });

  it('does not publish when the original deadline expires during the final ownership read', async () => {
    const request = reservation();
    jest.mocked(CommercialLlmShadowLease.prototype.owns).mockImplementation(async () => {
      now = request.deadlineAtMs;
      return true;
    });
    await server.dispatch(request);
    expect(mailbox.respond).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(lease);
  });

  it('does not post after close begins during lease retention', async () => {
    let closing: Promise<void> | undefined;
    jest
      .mocked(CommercialLlmShadowLease.prototype.retainUntilReleased)
      .mockImplementation(async () => {
        closing = server.close();
        return true;
      });
    await expect(server.dispatch(reservation())).rejects.toMatchObject({ kind: 'BUSY' });
    await closing;
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(release).toHaveBeenCalledWith(lease);
  });

  it.each([
    ['absent endpoint', () => new Response('{}', { status: 501 })],
    ['wrong media type', () => new Response('[]')],
    ['invalid JSON', () => new Response('[', { headers: { 'content-type': 'application/json' } })],
    ['empty array', () => Response.json([])],
    ['object', () => Response.json({ id: 0, n_ctx: 4096, is_processing: false })],
    ['null slot', () => Response.json([null])],
    ['multiple slots', () => Response.json([{ id: 0 }, { id: 1 }])],
    ['wrong slot', () => Response.json([{ id: 1, n_ctx: 4096, is_processing: false }])],
    ['wrong context', () => Response.json([{ id: 0, n_ctx: 8192, is_processing: false }])],
    ['missing processing', () => Response.json([{ id: 0, n_ctx: 4096 }])],
    ['string processing', () => Response.json([{ id: 0, n_ctx: 4096, is_processing: 'false' }])],
    ['numeric processing', () => Response.json([{ id: 0, n_ctx: 4096, is_processing: 0 }])],
    [
      'oversized body',
      () =>
        Response.json([{ id: 0, n_ctx: 4096, is_processing: false, extra: 'x'.repeat(65_536) }]),
    ],
  ] as const)(
    'refuses readiness and retains quarantine when /slots returns %s',
    async (_name, response) => {
      fetchImpl.mockImplementation(async () => response());
      now += 1_001;
      await server.tick();
      expect(mailbox.refreshWorker).toHaveBeenLastCalledWith('server-9b', session, false);
      fetchImpl.mockRejectedValueOnce(new Error('connection lost'));
      await expect(server.dispatch(reservation())).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
      fetchImpl.mockImplementation(async () => response());
      now += 1_001;
      await server.tick();
      expect(release).not.toHaveBeenCalled();
      expect(mailbox.refreshWorker).toHaveBeenLastCalledWith('server-9b', session, false);
    },
  );
  it('keeps heartbeat but never advertises a running inference and rejects a second dispatch', async () => {
    let complete!: (response: Response) => void;
    fetchImpl.mockImplementation(async (_url, init) =>
      init?.method === 'POST'
        ? new Promise<Response>((resolve) => {
            complete = resolve;
          })
        : new Response('{}'),
    );
    const first = server.dispatch(reservation());
    await new Promise<void>((resolve) => setImmediate(resolve));
    now += 1_001;
    await server.tick();
    expect(mailbox.refreshWorker).toHaveBeenLastCalledWith('server-9b', session, false);
    await expect(server.dispatch(reservation())).rejects.toMatchObject({ kind: 'BUSY' });
    complete(new Response(reply, { headers: { 'content-type': 'application/json' } }));
    await first;
  });
  it('never advertises an unverified template or an external endpoint', async () => {
    const unverified = new CommercialLlmPoolServer(
      redis,
      mailbox,
      'http://127.0.0.1:18084',
      async () => true,
      fetchImpl,
    );
    await unverified.tick();
    expect(mailbox.refreshWorker).toHaveBeenLastCalledWith('server-9b', session, false);
    await unverified.close();
    expect(
      () =>
        new CommercialLlmPoolServer(
          redis,
          mailbox,
          'https://untrusted.example',
          async () => true,
          fetchImpl,
        ),
    ).toThrow();
  });

  it.each([
    { name: 'verified single-slot capability', props: {}, ready: true },
    { name: 'disabled slots capability', props: { endpoint_slots: false }, ready: false },
    { name: 'missing slots capability', props: { endpoint_slots: undefined }, ready: false },
    { name: 'non-boolean slots capability', props: { endpoint_slots: 'true' }, ready: false },
    { name: 'multiple slots', props: { total_slots: 2 }, ready: false },
    { name: 'non-numeric slots count', props: { total_slots: '1' }, ready: false },
    { name: 'different template', props: { chat_template: 'unexpected' }, ready: false },
    { name: 'different model', props: {}, model: 'other-model', ready: false },
  ])('checks $name on the internal Docker endpoint without credentials', async (fixture) => {
    fetchImpl.mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/slots') return slotResponse(false);
      if (path === '/props')
        return Response.json({
          total_slots: 1,
          endpoint_slots: true,
          chat_template: 'fixture template',
          ...fixture.props,
        });
      return Response.json({
        data: [
          { id: fixture.model ?? COMMERCIAL_LLM_POOL_PROFILES['server-9b'].identity.modelAlias },
        ],
      });
    });
    fetchImpl.mockClear();
    const verified = new CommercialLlmPoolServer(
      redis,
      mailbox,
      'http://gemma-commercial-shadow:8080',
      async () => true,
      fetchImpl,
    );
    await verified.tick();
    expect(mailbox.refreshWorker).toHaveBeenLastCalledWith('server-9b', session, fixture.ready);
    expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/slots',
      '/props',
      '/v1/models',
    ]);
    expect(
      fetchImpl.mock.calls.every(
        ([url, init]) =>
          new URL(String(url)).host === 'gemma-commercial-shadow:8080' &&
          new Headers(init?.headers).get('authorization') === null,
      ),
    ).toBe(true);
    await verified.close();
  });

  it('drains an actual HTTP operation before withdrawing its worker session', async () => {
    let complete!: (response: Response) => void;
    fetchImpl.mockImplementation(async (_url, init) =>
      init?.method === 'POST'
        ? new Promise<Response>((resolve) => {
            complete = resolve;
          })
        : new Response('{}'),
    );
    const work = server.dispatch(reservation());
    await new Promise<void>((resolve) => setImmediate(resolve));
    const closing = server.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mailbox.releaseWorker).not.toHaveBeenCalled();
    complete(new Response(reply, { headers: { 'content-type': 'application/json' } }));
    await Promise.all([work, closing]);
    expect(mailbox.releaseWorker).toHaveBeenCalledWith('server-9b', session);
  });
});
