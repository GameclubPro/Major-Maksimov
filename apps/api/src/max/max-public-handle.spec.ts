import { parsePublicMaxChannelData, resolvePublicMaxHandle } from './max-public-handle';

const url = 'https://max.ru/azov_overhear';
const channelId = 69253552423018;

// Shape observed on MAX's public /<name>/__data.json page; references are table indexes.
function channelData() {
  const table: unknown[] = [
    { linkInfo: 1, isBot: 8, canonical: 9 },
    { channel: 2 },
    { title: 3, description: 4, icon: 5, participantsCount: 6, channelId: 7 },
    'Channel title',
    'Description',
    'https://example.org/icon',
    3805,
    channelId,
    true,
    url,
  ];
  return { table, value: { type: 'data', nodes: [null, { type: 'data', data: table }, null] } };
}

describe('public MAX channel proof', () => {
  it('reads the typed channel and exact canonical URL, independently of the crawler isBot flag', () => {
    const { value, table } = channelData();
    expect(parsePublicMaxChannelData(value, url)).toEqual({ url, channelId });
    table[8] = false;
    expect(parsePublicMaxChannelData(value, url)).toEqual({ url, channelId });
  });

  it.each([{ user: 2 }, { contact: 2 }, { bot: 2 }, { chat: 2 }, { channel: 2, user: 2 }, {}])(
    'preserves a person, bot, unsupported or ambiguous target: %j',
    (info) => {
      const { table, value } = channelData();
      table[1] = info;
      table[4] = 'channel channelId 69253552423018';
      expect(parsePublicMaxChannelData(value, url)).toBeNull();
    },
  );

  it.each([0, -42, 1.5, Number.MAX_SAFE_INTEGER + 1, '69253552423018', null])(
    'rejects invalid channel identity %j',
    (id) => {
      const { value, table } = channelData();
      table[7] = id;
      expect(parsePublicMaxChannelData(value, url)).toBeNull();
    },
  );

  it.each([-1, 99, 1.5, '1', null])('rejects invalid devalue references %j', (index) => {
    const { value, table } = channelData();
    table[0] = { linkInfo: index, canonical: 9 };
    expect(parsePublicMaxChannelData(value, url)).toBeNull();
  });

  it('rejects mismatched canonical names and multiple proofs', () => {
    const { value, table } = channelData();
    expect(parsePublicMaxChannelData(value, 'https://max.ru/person')).toBeNull();
    value.nodes.push({ type: 'data', data: table });
    expect(parsePublicMaxChannelData(value, url)).toBeNull();
  });

  it.each([
    null,
    [],
    {},
    { type: 'redirect', location: url },
    { type: 'data', nodes: {} },
    { type: 'data', nodes: Array(17).fill(null) },
  ])('rejects unsupported envelopes %j', (value) => {
    expect(parsePublicMaxChannelData(value, url)).toBeNull();
  });
});

describe('bounded public MAX lookup', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const response = () => Response.json(channelData().value);

  it('fetches only the fixed public endpoint, without credentials, redirects or reusable identity cache', async () => {
    fetchMock.mockImplementation(async () => response());
    expect(await resolvePublicMaxHandle(url, 800)).toEqual({ url, channelId });
    expect(fetchMock).toHaveBeenCalledWith(
      `${url}/__data.json`,
      expect.objectContaining({
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal: expect.any(AbortSignal),
      }),
    );
    fetchMock.mockResolvedValue(Response.json({ type: 'data', nodes: [] }));
    expect(await resolvePublicMaxHandle(url, 800)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    'http://max.ru/name',
    'https://max.ru.evil/name',
    'https://user@max.ru/name',
    'https://max.ru/name?token=x',
    'https://max.ru/name#part',
    'https://max.ru/../name',
    'https://max.ru/name/path',
    'https://127.0.0.1/name',
  ])('does not request %s', async (target) => {
    expect(await resolvePublicMaxHandle(target, 800)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([0, -1, NaN, Infinity])('does not request with invalid budget %s', async (budget) => {
    expect(await resolvePublicMaxHandle(url, budget)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([403, 404, 429, 500])('keeps status %s uncertain', async (status) => {
    fetchMock.mockResolvedValue(Response.json(channelData().value, { status }));
    expect(await resolvePublicMaxHandle(url, 800)).toBeNull();
  });

  it('rejects HTML, invalid JSON, oversized declared and streamed bodies, and broken streams', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('broken'));
      },
    });
    for (const item of [
      new Response('<html>channel</html>', { headers: { 'content-type': 'text/html' } }),
      new Response('{', { headers: { 'content-type': 'application/json' } }),
      Response.json(channelData().value, { headers: { 'content-length': '65537' } }),
      new Response(' '.repeat(65537), { headers: { 'content-type': 'application/json' } }),
      new Response(broken, { headers: { 'content-type': 'application/json' } }),
    ]) {
      fetchMock.mockResolvedValue(item);
      expect(await resolvePublicMaxHandle(url, 800)).toBeNull();
    }
    fetchMock.mockRejectedValue(new Error('network failure or redirect refused'));
    expect(await resolvePublicMaxHandle(url, 800)).toBeNull();
    fetchMock.mockResolvedValue(response());
    expect(await resolvePublicMaxHandle(url, 800)).toEqual({ url, channelId });
  });

  it('aborts timed-out requests, bounds concurrency and releases capacity', async () => {
    jest.useFakeTimers();
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init!.signal!;
          signals.push(signal);
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const first = resolvePublicMaxHandle(url, 800);
    const second = resolvePublicMaxHandle(url, 20_000);
    expect(await resolvePublicMaxHandle(url, 800)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(800);
    expect(await first).toBeNull();
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1_200);
    expect(await second).toBeNull();
    expect(signals[1]?.aborted).toBe(true);
    fetchMock.mockResolvedValue(response());
    expect(await resolvePublicMaxHandle(url, 800)).toEqual({ url, channelId });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps the deadline active while reading a stalled body', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(
      async (_input, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init!.signal!.addEventListener(
                'abort',
                () => controller.error(new Error('body aborted')),
                { once: true },
              );
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    const pending = resolvePublicMaxHandle(url, 100);
    await jest.advanceTimersByTimeAsync(100);
    expect(await pending).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });
});
