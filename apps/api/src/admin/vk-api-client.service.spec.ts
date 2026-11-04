import { ConfigService } from '@nestjs/config';
import { VkApiClientService } from './vk-api-client.service';
import {
  classifyVkParsingSyncError,
  readVkRetryAtMs,
  VK_API_MAX_RETRY_AT_MS,
  VkApiRequestError,
} from './vk-parsing-errors';
import type { VkParsingRateLimitService } from './vk-parsing-rate-limit.service';

describe('VkApiClientService transport', () => {
  const originalFetch = global.fetch;
  const metrics: jest.Mocked<
    Pick<
      VkParsingRateLimitService,
      'reserveVkApiSlot' | 'publishVkApiCooldown' | 'recordVkApiOutcome'
    >
  > = {
    reserveVkApiSlot: jest.fn().mockResolvedValue(undefined),
    publishVkApiCooldown: jest.fn().mockResolvedValue(undefined),
    recordVkApiOutcome: jest.fn().mockResolvedValue(undefined),
  };

  function createService(config: Record<string, unknown> = {}) {
    return new VkApiClientService(
      new ConfigService({ VK_SERVICE_TOKEN: 'test-token', VK_API_MAX_ATTEMPTS: 1, ...config }),
      metrics as never,
    );
  }

  beforeEach(() => {
    jest.resetAllMocks();
    metrics.reserveVkApiSlot.mockResolvedValue(undefined);
    metrics.publishVkApiCooldown.mockResolvedValue(undefined);
    metrics.recordVkApiOutcome.mockResolvedValue(undefined);
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('preserves a safe machine-readable error code across HTTP', () => {
    const retryAtMs = Date.now() + 120_000;
    const error = new VkApiRequestError('VK requires captcha', 'vk_14', false, retryAtMs);
    expect(error.getResponse()).toEqual({
      statusCode: 503,
      message: 'VK requires captcha',
      code: 'VK_API_VK_14',
      retryable: false,
    });
    expect(error.code).toBe('vk_14');
    expect(error.retryAtMs).toBe(retryAtMs);
  });

  it.each([1, 1_767_225_600_000, VK_API_MAX_RETRY_AT_MS])(
    'propagates the valid internal retry deadline %s without adding HTTP response keys',
    (retryAtMs) => {
      expect(readVkRetryAtMs(retryAtMs)).toBe(retryAtMs);
      const error = new VkApiRequestError('wait', 'http_429', true, retryAtMs);
      expect(classifyVkParsingSyncError(error)).toMatchObject({
        code: 'vk_api.http_429',
        retryable: true,
        retryAtMs,
      });
      expect(error.getResponse()).not.toHaveProperty('retryAtMs');
    },
  );

  it.each([
    undefined,
    null,
    '123',
    NaN,
    Infinity,
    -Infinity,
    -1,
    0,
    1.5,
    VK_API_MAX_RETRY_AT_MS + 1,
    8_640_000_000_000_000,
    8_640_000_000_000_001,
  ])('rejects an invalid internal retry deadline %s', (value) => {
    expect(readVkRetryAtMs(value)).toBeUndefined();
    const error = new VkApiRequestError(
      'wait',
      'http_429',
      true,
      typeof value === 'number' ? value : undefined,
    );
    expect(error.retryAtMs).toBeUndefined();
    Object.assign(error, { retryAtMs: value });
    expect(classifyVkParsingSyncError(error)).not.toHaveProperty('retryAtMs');
  });

  it('keeps the abort deadline active while reading the response body', async () => {
    global.fetch = jest.fn(
      async (_url, options) =>
        ({
          ok: true,
          json: () =>
            new Promise((_resolve, reject) => {
              options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
                once: true,
              });
            }),
        }) as Response,
    );
    const result = expect(
      createService({ VK_API_TIMEOUT_MS: 100 }).request('wall.get', {}),
    ).rejects.toMatchObject({ code: 'timeout', retryable: true });
    await jest.advanceTimersByTimeAsync(100);
    await result;
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([401, 403, 404, 408, 429, 500, 503])(
    'classifies HTTP %i before parsing an HTML error body',
    async (status) => {
      const response = new Response('<html>error</html>', { status });
      global.fetch = jest.fn().mockResolvedValue(response);
      await expect(createService().request('wall.get', {})).rejects.toMatchObject({
        code: `http_${status}`,
        retryable: status === 408 || status === 429 || status >= 500,
      });
      expect(response.body?.locked).toBe(false);
    },
  );

  it.each([{}, null, { response: null }, { unexpected: [] }])(
    'rejects missing response envelopes: %j',
    async (payload) => {
      global.fetch = jest.fn().mockResolvedValue(Response.json(payload));
      await expect(createService().request('wall.get', {})).rejects.toMatchObject({
        code: 'invalid_response',
      });
      expect(metrics.recordVkApiOutcome).not.toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'success' }),
      );
    },
  );

  it('keeps the token in the authorization header and accepts an empty successful list', async () => {
    global.fetch = jest.fn().mockResolvedValue(Response.json({ response: [] }));
    await expect(createService().request('wall.getById', { posts: '-1_2' })).resolves.toEqual([]);
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0]!;
    expect(url).not.toContain('test-token');
    expect(options.headers.Authorization).toBe('Bearer test-token');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('preserves a long Retry-After deadline without issuing another VK request', async () => {
    const startedAtMs = Date.now();
    global.fetch = jest.fn(
      async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } }),
    );
    const result = createService({ VK_API_MAX_ATTEMPTS: 3 })
      .request('wall.get', {})
      .catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(1_000);
    const error = await result;
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({
      code: 'http_429',
      retryable: true,
      retryAtMs: startedAtMs + 120_000,
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    'Thu, 01 Jan 2026 00:02:00 GMT',
    'Thursday, 01-Jan-26 00:02:00 GMT',
    'Thu Jan  1 00:02:00 2026',
  ])('honors the HTTP-date Retry-After form %s', async (header) => {
    const retryAtMs = Date.now() + 120_000;
    global.fetch = jest.fn(
      async () => new Response('', { status: 503, headers: { 'Retry-After': header } }),
    );
    await expect(
      createService({ VK_API_MAX_ATTEMPTS: 3 }).request('wall.get', {}),
    ).rejects.toMatchObject({ code: 'http_503', retryable: true, retryAtMs });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(metrics.publishVkApiCooldown).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-f0-9]{64}$/u),
      retryAtMs,
    );
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['2026-01-01T00:00:00Z', '2026-07-01T00:00:00Z'])(
    'accepts an obsolete HTTP-date at or before the full 50-year boundary from %s',
    async (receivedAt) => {
      jest.setSystemTime(new Date(receivedAt));
      const retryAtMs = Date.UTC(2076, 0, 1);
      global.fetch = jest.fn(
        async () =>
          new Response('', {
            status: 429,
            headers: { 'Retry-After': 'Wednesday, 01-Jan-76 00:00:00 GMT' },
          }),
      );
      await expect(createService().request('wall.get', {})).rejects.toMatchObject({
        code: 'http_429',
        retryAtMs,
      });
      expect(metrics.publishVkApiCooldown).toHaveBeenCalledWith(expect.any(String), retryAtMs);
    },
  );

  it.each(['delta-seconds', 'HTTP-date'] as const)(
    'accepts the last persistable year from a %s Retry-After',
    async (format) => {
      jest.setSystemTime(new Date('2026-01-01T00:00:00.999Z'));
      const retryAtMs =
        format === 'delta-seconds' ? VK_API_MAX_RETRY_AT_MS : VK_API_MAX_RETRY_AT_MS - 999;
      const header =
        format === 'delta-seconds'
          ? String((retryAtMs - Date.now()) / 1_000)
          : new Date(retryAtMs).toUTCString();
      expect(new Date(VK_API_MAX_RETRY_AT_MS).toISOString()).toBe('9999-12-31T23:59:59.999Z');
      global.fetch = jest.fn(
        async () => new Response('', { status: 429, headers: { 'Retry-After': header } }),
      );

      await expect(
        createService({ VK_API_MAX_ATTEMPTS: 3 }).request('wall.get', {}),
      ).rejects.toMatchObject({ code: 'http_429', retryable: true, retryAtMs });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(metrics.publishVkApiCooldown).toHaveBeenCalledWith(expect.any(String), retryAtMs);
    },
  );

  it('measures delta-seconds at response receipt rather than request start', async () => {
    const startedAtMs = Date.now();
    global.fetch = jest.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return new Response('', { status: 429, headers: { 'Retry-After': '120' } });
    });
    const result = createService()
      .request('wall.get', {})
      .catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(400);
    expect(await result).toMatchObject({ retryAtMs: startedAtMs + 120_400 });
  });

  it('waits for a short provider deadline before retrying the HTTP read', async () => {
    const retryAtMs = Date.now() + 1_000;
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '1' } }))
      .mockResolvedValueOnce(Response.json({ response: [] }));
    const result = createService({ VK_API_MAX_ATTEMPTS: 3 }).request('wall.get', {});
    await jest.advanceTimersByTimeAsync(999);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual([]);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(metrics.publishVkApiCooldown).toHaveBeenCalledTimes(1);
    expect(metrics.publishVkApiCooldown).toHaveBeenCalledWith(expect.any(String), retryAtMs);
  });

  it.each([
    undefined,
    '',
    '0',
    '-1',
    '1.5',
    '1e3',
    'invalid',
    'Wed, 01 Jan 2025 00:00:00 GMT',
    '2027-01-01T00:00:00Z',
    'Sun, 31 Feb 2027 00:00:00 GMT',
    'Wednesday, 01-Jan-76 00:00:01 GMT',
    String((VK_API_MAX_RETRY_AT_MS + 1 - Date.UTC(2026, 0, 1)) / 1_000),
    String((8_640_000_000_000_000 - Date.UTC(2026, 0, 1)) / 1_000),
    '999999999999999999999999999999999999',
    '8640000000000',
  ])('keeps ordinary backoff for a missing, past or invalid Retry-After %s', async (header) => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response('', {
          status: 429,
          headers: header === undefined ? undefined : { 'Retry-After': header },
        }),
      )
      .mockResolvedValueOnce(Response.json({ response: [] }));
    const result = createService({ VK_API_MAX_ATTEMPTS: 2 }).request('wall.get', {});
    await jest.advanceTimersByTimeAsync(249);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual([]);
    expect(metrics.publishVkApiCooldown).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404])(
    'does not apply a Retry-After header to terminal HTTP %s',
    async (status) => {
      global.fetch = jest.fn(
        async () => new Response('', { status, headers: { 'Retry-After': '120' } }),
      );
      await expect(
        createService({ VK_API_MAX_ATTEMPTS: 3 }).request('wall.get', {}),
      ).rejects.toMatchObject({ code: `http_${status}`, retryable: false, retryAtMs: undefined });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(metrics.publishVkApiCooldown).not.toHaveBeenCalled();
    },
  );

  it.each([429, 401])(
    'preserves HTTP %s evidence when body cleanup finishes after abort',
    async (status) => {
      const retryAtMs = Date.now() + 120_000;
      const response = new Response('', { status, headers: { 'Retry-After': '120' } });
      const cancel = jest
        .spyOn(response.body!, 'cancel')
        .mockImplementation(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
      let signal: AbortSignal | null | undefined;
      global.fetch = jest.fn(async (_url, options) => {
        signal = options?.signal;
        return response;
      });
      const result = createService({ VK_API_TIMEOUT_MS: 50 })
        .request('wall.get', {})
        .catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(100);
      expect(signal?.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(await result).toMatchObject({
        code: `http_${status}`,
        retryable: status === 429,
        retryAtMs: status === 429 ? retryAtMs : undefined,
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('preserves the originating provider error when cooldown publication fails', async () => {
    const retryAtMs = Date.now() + 120_000;
    metrics.publishVkApiCooldown.mockRejectedValueOnce(new Error('Redis acknowledgement lost'));
    global.fetch = jest.fn(
      async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } }),
    );
    await expect(
      createService({ VK_API_MAX_ATTEMPTS: 3 }).request('wall.get', {}),
    ).rejects.toMatchObject({ code: 'http_429', retryable: true, retryAtMs });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(metrics.publishVkApiCooldown).toHaveBeenCalledTimes(1);
  });

  it('publishes observed cooldown before waiting for outcome metrics', async () => {
    let releaseMetrics: (() => void) | undefined;
    metrics.recordVkApiOutcome.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseMetrics = resolve;
        }),
    );
    global.fetch = jest.fn(
      async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } }),
    );
    const result = createService()
      .request('wall.get', {})
      .catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(0);
    expect(metrics.publishVkApiCooldown).toHaveBeenCalledTimes(1);
    expect(metrics.publishVkApiCooldown.mock.invocationCallOrder[0]).toBeLessThan(
      metrics.recordVkApiOutcome.mock.invocationCallOrder[0]!,
    );
    expect(releaseMetrics).toBeDefined();
    releaseMetrics!();
    expect(await result).toMatchObject({ code: 'http_429', retryAtMs: Date.now() + 120_000 });
  });

  it('returns a shared provider cooldown promptly without republishing or sleeping', async () => {
    const error = new VkApiRequestError('wait', 'provider_cooldown', true, Date.now() + 5_000);
    metrics.reserveVkApiSlot.mockRejectedValueOnce(error);
    global.fetch = jest.fn();
    await expect(createService({ VK_API_MAX_ATTEMPTS: 3 }).request('wall.get', {})).rejects.toBe(
      error,
    );
    expect(metrics.reserveVkApiSlot).toHaveBeenCalledTimes(1);
    expect(metrics.publishVkApiCooldown).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not fetch after a late admission consumes the request budget', async () => {
    metrics.reserveVkApiSlot.mockImplementationOnce(
      () => new Promise<void>((resolve) => setTimeout(resolve, 20_001)),
    );
    global.fetch = jest.fn();
    const result = createService({ VK_API_MAX_ATTEMPTS: 3 })
      .request('wall.get', {})
      .catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(20_001);
    expect(await result).toMatchObject({ code: 'timeout' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(metrics.reserveVkApiSlot).toHaveBeenCalledTimes(1);
  });

  it('checks the request budget before reserving a quota slot', async () => {
    const now = Date.now();
    jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(now)
      .mockReturnValue(now + 20_000);
    global.fetch = jest.fn();
    await expect(createService().request('wall.get', {})).rejects.toMatchObject({
      code: 'timeout',
    });
    expect(metrics.reserveVkApiSlot).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('keeps outcome metric failure separate from a successful HTTP result', async () => {
    metrics.recordVkApiOutcome.mockRejectedValueOnce(new Error('metrics unavailable'));
    global.fetch = jest.fn(async () => Response.json({ response: [] }));
    await expect(
      createService({ VK_API_MAX_ATTEMPTS: 3 }).request('wall.get', {}),
    ).resolves.toEqual([]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('uses a token-free credential scope normalized by API origin and trimmed token', async () => {
    global.fetch = jest.fn(async () => Response.json({ response: [] }));
    for (const config of [
      { VK_SERVICE_TOKEN: ' test-token ', VK_API_BASE_URL: 'https://API.VK.RU:443/' },
      { VK_SERVICE_TOKEN: 'test-token', VK_API_BASE_URL: 'https://api.vk.ru' },
      { VK_SERVICE_TOKEN: 'other-token', VK_API_BASE_URL: 'https://api.vk.ru' },
      { VK_SERVICE_TOKEN: 'test-token', VK_API_BASE_URL: 'https://other.example' },
    ])
      await createService(config).request('wall.get', {});
    const options = metrics.reserveVkApiSlot.mock.calls.map(([, admission]) => admission);
    expect(options.every(({ credentialScope }) => /^[a-f0-9]{64}$/u.test(credentialScope))).toBe(
      true,
    );
    expect(options[0]!.credentialScope).toBe(options[1]!.credentialScope);
    expect(options[2]!.credentialScope).not.toBe(options[0]!.credentialScope);
    expect(options[3]!.credentialScope).not.toBe(options[0]!.credentialScope);
    expect(options.every(({ deadlineAtMs }) => deadlineAtMs === Date.now() + 20_000)).toBe(true);
    expect(JSON.stringify(options)).not.toMatch(/test-token|other-token/u);
  });

  it('rejects missing credentials before attempting scope parsing or admission', async () => {
    global.fetch = jest.fn();
    await expect(
      createService({ VK_SERVICE_TOKEN: undefined, VK_API_BASE_URL: 'invalid' }).request(
        'wall.get',
        {},
      ),
    ).rejects.toThrow('VK_SERVICE_TOKEN');
    expect(metrics.reserveVkApiSlot).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('bounds network attempts by one request deadline', async () => {
    global.fetch = jest.fn(
      async (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    const result = expect(
      createService({ VK_API_MAX_ATTEMPTS: 5 }).request('wall.get', {}),
    ).rejects.toMatchObject({ code: 'timeout' });
    await jest.advanceTimersByTimeAsync(20_000);
    await result;
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });
});
