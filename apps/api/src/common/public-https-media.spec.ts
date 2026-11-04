import { EventEmitter } from 'node:events';
import type { RequestOptions } from 'node:https';
import type { LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from 'node:zlib';
import {
  readBoundedResponseBuffer,
  ResponseByteLimitExceededError,
} from './bounded-response-buffer';
import {
  createPinnedHttpsExchange,
  createPublicHttpsMediaFetcher,
  PublicHttpsMediaError,
  type PublicHttpsMediaDependencies,
  type PublicMediaAddress,
  type PublicMediaExchange,
  type PublicMediaIncomingMessage,
  type PublicMediaRequest,
  type PublicMediaRequestFactory,
} from './public-https-media';

const PUBLIC_V4: PublicMediaAddress = { address: '8.8.8.8', family: 4 };
const PUBLIC_V6: PublicMediaAddress = { address: '2001:4860:4860::8888', family: 6 };
const PHOTO = 'https://cdn.vk.test/photo.jpg';

function exchange(
  status = 200,
  headers: HeadersInit = { 'content-type': 'image/jpeg' },
  chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array> = [Buffer.from([1, 2, 3])],
) {
  const body = Readable.from(chunks, { objectMode: false });
  const close = jest.fn((error?: Error) => {
    body.destroy(error);
  });
  return { status, headers: new Headers(headers), body, close } satisfies PublicMediaExchange;
}

function fixture() {
  const resolveAll = jest
    .fn<
      ReturnType<PublicHttpsMediaDependencies['resolveAll']>,
      Parameters<PublicHttpsMediaDependencies['resolveAll']>
    >()
    .mockResolvedValue([PUBLIC_V4]);
  const exchangePinned = jest.fn<
    ReturnType<PublicHttpsMediaDependencies['exchangePinned']>,
    Parameters<PublicHttpsMediaDependencies['exchangePinned']>
  >();
  const signal = new AbortController().signal;
  return {
    resolveAll,
    exchangePinned,
    signal,
    fetch: createPublicHttpsMediaFetcher({ resolveAll, exchangePinned }),
  };
}

describe('public HTTPS media admission', () => {
  it.each([
    'http://cdn.vk.test/photo.jpg',
    'https://user:password@cdn.vk.test/photo.jpg',
    'https://@cdn.vk.test/photo.jpg',
    'https://cdn.vk.test:8443/photo.jpg',
    'https://127.0.0.1/photo.jpg',
    'https://2130706433/photo.jpg',
    'https://0x7f000001/photo.jpg',
    'https://0177.0.0.1/photo.jpg',
    'https://10.0.0.1/photo.jpg',
    'https://100.64.0.1/photo.jpg',
    'https://169.254.169.254/photo.jpg',
    'https://172.16.0.1/photo.jpg',
    'https://192.0.0.1/photo.jpg',
    'https://192.168.1.1/photo.jpg',
    'https://198.18.0.1/photo.jpg',
    'https://203.0.113.1/photo.jpg',
    'https://224.0.0.1/photo.jpg',
    'https://[::1]/photo.jpg',
    'https://[::ffff:8.8.8.8]/photo.jpg',
    'https://[0:0:0:0:0:ffff:7f00:1]/photo.jpg',
    'https://[fe80::1]/photo.jpg',
    'https://[fc00::1]/photo.jpg',
    'https://[2001:db8::1]/photo.jpg',
    'https://[2002:0808:0808::1]/photo.jpg',
    'https://[3fff::1]/photo.jpg',
  ])('refuses %s without resolving or connecting', async (url) => {
    const f = fixture();
    await expect(f.fetch(url, { signal: f.signal })).rejects.toBeInstanceOf(PublicHttpsMediaError);
    expect(f.resolveAll).not.toHaveBeenCalled();
    expect(f.exchangePinned).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'empty', addresses: [] },
    { name: 'mixed IPv4', addresses: [PUBLIC_V4, { address: '127.0.0.1', family: 4 }] },
    { name: 'mapped IPv6', addresses: [PUBLIC_V6, { address: '::ffff:127.0.0.1', family: 6 }] },
    { name: 'wrong family', addresses: [{ address: PUBLIC_V6.address, family: 4 }] },
    { name: 'invalid address', addresses: [{ address: 'not-an-address', family: 4 }] },
  ] satisfies Array<{ name: string; addresses: PublicMediaAddress[] }>)(
    'refuses $name DNS answers',
    async ({ addresses }) => {
      const f = fixture();
      f.resolveAll.mockResolvedValue(addresses);
      await expect(f.fetch(PHOTO, { signal: f.signal })).rejects.toMatchObject({
        code: 'destination_denied',
      });
      expect(f.exchangePinned).not.toHaveBeenCalled();
    },
  );

  it('prefers an admitted IPv4 answer and preserves the caller signal', async () => {
    const f = fixture();
    f.resolveAll.mockResolvedValue([PUBLIC_V6, PUBLIC_V4]);
    const wire = exchange();
    f.exchangePinned.mockResolvedValue(wire);
    const response = await f.fetch(PHOTO, { signal: f.signal });
    expect(f.exchangePinned).toHaveBeenCalledWith(new URL(PHOTO), PUBLIC_V4, { signal: f.signal });
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
    expect(wire.close).toHaveBeenCalledTimes(1);
  });

  it('accepts public IPv6 and public literals without another DNS lookup', async () => {
    const f = fixture();
    f.exchangePinned.mockResolvedValue(exchange());
    const response = await f.fetch(`https://[${PUBLIC_V6.address}]/photo.jpg`, {
      signal: f.signal,
    });
    expect(f.resolveAll).not.toHaveBeenCalled();
    expect(f.exchangePinned).toHaveBeenCalledWith(expect.any(URL), PUBLIC_V6, {
      signal: f.signal,
    });
    await response.body?.cancel();
  });

  it.each(['http://cdn.vk.test/next.jpg', 'https://127.0.0.1/next.jpg'])(
    'closes a redirect before refusing its unsafe destination %s',
    async (location) => {
      const f = fixture();
      const first = exchange(302, { location });
      f.exchangePinned.mockResolvedValue(first);
      await expect(f.fetch(PHOTO, { signal: f.signal })).rejects.toBeInstanceOf(
        PublicHttpsMediaError,
      );
      expect(first.close).toHaveBeenCalledTimes(1);
      expect(f.exchangePinned).toHaveBeenCalledTimes(1);
      expect(f.resolveAll).toHaveBeenCalledTimes(1);
    },
  );

  it('rechecks relative redirects, closes the abandoned body and retains HEAD', async () => {
    const f = fixture();
    const first = exchange(303, { location: '/next.jpg#ignored' });
    const second = exchange();
    f.exchangePinned.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const response = await f.fetch(PHOTO, { method: 'HEAD', signal: f.signal });
    expect(f.resolveAll).toHaveBeenCalledTimes(2);
    expect(first.close.mock.invocationCallOrder[0]).toBeLessThan(
      f.resolveAll.mock.invocationCallOrder[1]!,
    );
    expect(f.exchangePinned).toHaveBeenNthCalledWith(
      2,
      new URL('https://cdn.vk.test/next.jpg'),
      PUBLIC_V4,
      {
        method: 'HEAD',
        signal: f.signal,
      },
    );
    expect(response.body).toBeNull();
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 'https://[invalid', `/${'a'.repeat(8_193)}`])(
    'refuses missing, malformed or oversized redirect locations',
    async (location) => {
      const f = fixture();
      const first = exchange(302, location === undefined ? {} : { location });
      f.exchangePinned.mockResolvedValue(first);
      await expect(f.fetch(PHOTO, { signal: f.signal })).rejects.toBeInstanceOf(
        PublicHttpsMediaError,
      );
      expect(first.close).toHaveBeenCalledTimes(1);
      expect(f.exchangePinned).toHaveBeenCalledTimes(1);
    },
  );

  it('refuses redirect loops and a sixth redirect without another connection', async () => {
    const loop = fixture();
    loop.exchangePinned.mockResolvedValue(exchange(302, { location: PHOTO }));
    await expect(loop.fetch(PHOTO, { signal: loop.signal })).rejects.toMatchObject({
      code: 'redirect_loop',
    });
    expect(loop.exchangePinned).toHaveBeenCalledTimes(1);

    const hops = fixture();
    for (let index = 1; index <= 6; index += 1) {
      hops.exchangePinned.mockResolvedValueOnce(exchange(302, { location: `/hop-${index}` }));
    }
    await expect(hops.fetch(PHOTO, { signal: hops.signal })).rejects.toMatchObject({
      code: 'redirect_limit',
    });
    expect(hops.exchangePinned).toHaveBeenCalledTimes(6);
  });

  it('bounds the initial URL before DNS', async () => {
    const f = fixture();
    await expect(
      f.fetch(`${PHOTO}?${'x'.repeat(8_193)}`, { signal: f.signal }),
    ).rejects.toMatchObject({
      code: 'url_invalid',
    });
    expect(f.resolveAll).not.toHaveBeenCalled();
  });

  it('abandons DNS on the original signal and handles its late rejection', async () => {
    const f = fixture();
    const controller = new AbortController();
    let rejectLookup: (error: Error) => void = () => undefined;
    f.resolveAll.mockReturnValue(
      new Promise((_, reject) => {
        rejectLookup = reject;
      }),
    );
    const response = f.fetch(PHOTO, { signal: controller.signal });
    controller.abort();
    await expect(response).rejects.toMatchObject({ name: 'AbortError' });
    rejectLookup(new Error('late resolver failure'));
    await nextTurn();
    expect(f.exchangePinned).not.toHaveBeenCalled();
  });

  it('keeps cancellation active after headers and closes a stalled body', async () => {
    const f = fixture();
    const controller = new AbortController();
    const body = new Readable({ read() {} });
    const wire = {
      status: 200,
      headers: new Headers(),
      body,
      close: jest.fn((error?: Error) => {
        body.destroy(error);
      }),
    } satisfies PublicMediaExchange;
    f.exchangePinned.mockResolvedValue(wire);
    const response = await f.fetch(PHOTO, { signal: controller.signal });
    const reader = response.body!.getReader();
    const reading = reader.read();
    controller.abort();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    reader.releaseLock();
    expect(wire.close).toHaveBeenCalledTimes(1);
    expect(wire.body.destroyed).toBe(true);
  });

  it('bounds unread body prefetch in bytes and cancels its source', async () => {
    const f = fixture();
    let produced = 0;
    const body = new Readable({
      highWaterMark: 1_024,
      read() {
        produced += 1;
        this.push(Buffer.alloc(1_024));
      },
    });
    const close = jest.fn((error?: Error) => {
      body.destroy(error);
    });
    f.exchangePinned.mockResolvedValue({ status: 200, headers: new Headers(), body, close });
    const response = await f.fetch(PHOTO, { signal: f.signal });
    await nextTurn();
    await nextTurn();
    expect(produced).toBeGreaterThan(0);
    expect(produced).toBeLessThanOrEqual(256);
    await response.body!.cancel();
    expect(body.destroyed).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('public HTTPS media representations', () => {
  const payload = Buffer.from('decoded media bytes');

  it.each([
    ['gzip', gzipSync(payload)],
    ['deflate', deflateSync(payload)],
    ['deflate', deflateRawSync(payload)],
    ['br', brotliCompressSync(payload)],
    ['gzip, br', brotliCompressSync(gzipSync(payload))],
  ] as const)('streams %s and removes wire length metadata', async (coding, encoded) => {
    const f = fixture();
    const wire = exchange(
      200,
      {
        'content-type': 'image/jpeg',
        'content-encoding': coding,
        'content-length': String(encoded.length),
        'content-range': `bytes 0-${encoded.length - 1}/${encoded.length}`,
      },
      (async function* () {
        yield encoded.subarray(0, 1);
        await nextTurn();
        yield encoded.subarray(1, 2);
        await nextTurn();
        yield encoded.subarray(2);
      })(),
    );
    f.exchangePinned.mockResolvedValue(wire);
    const response = await f.fetch(PHOTO, { signal: f.signal });
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('content-range')).toBeNull();
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(payload);
    expect(wire.close).toHaveBeenCalledTimes(1);
  });

  it('enforces the image budget on decoded bytes and closes the compressed source', async () => {
    const f = fixture();
    const limit = 10 * 1_024 * 1_024;
    const encoded = gzipSync(Buffer.alloc(limit + 1));
    const wire = exchange(
      200,
      { 'content-encoding': 'gzip', 'content-length': String(encoded.length) },
      [encoded],
    );
    f.exchangePinned.mockResolvedValue(wire);
    const response = await f.fetch(PHOTO, { signal: f.signal });
    await expect(readBoundedResponseBuffer(response, limit, f.signal)).rejects.toBeInstanceOf(
      ResponseByteLimitExceededError,
    );
    expect(wire.close).toHaveBeenCalledTimes(1);
    expect(wire.body.destroyed).toBe(true);
  });

  it.each(['zstd', 'gzip, gzip, gzip, gzip'])(
    'refuses unsupported coding %s before reading',
    async (coding) => {
      const f = fixture();
      const wire = exchange(200, { 'content-encoding': coding });
      f.exchangePinned.mockResolvedValue(wire);
      await expect(f.fetch(PHOTO, { signal: f.signal })).rejects.toMatchObject({
        code: 'encoding_unsupported',
      });
      expect(wire.close).toHaveBeenCalledTimes(1);
    },
  );

  it('reports corrupt compressed data as a fixed typed failure', async () => {
    const f = fixture();
    const wire = exchange(200, { 'content-encoding': 'gzip' }, [Buffer.from('corrupt')]);
    f.exchangePinned.mockResolvedValue(wire);
    const response = await f.fetch(PHOTO, { signal: f.signal });
    await expect(response.arrayBuffer()).rejects.toMatchObject({ code: 'decoding_failed' });
    expect(wire.close).toHaveBeenCalledTimes(1);
  });

  it('aborts while waiting for the second deflate prefix byte', async () => {
    const f = fixture();
    const controller = new AbortController();
    let firstByteRead: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      firstByteRead = resolve;
    });
    let sent = false;
    const body = new Readable({
      read() {
        if (!sent) {
          sent = true;
          this.push(Buffer.from([0x78]));
          firstByteRead();
        }
      },
    });
    const close = jest.fn((error?: Error) => {
      body.destroy(error);
    });
    f.exchangePinned.mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-encoding': 'deflate' }),
      body,
      close,
    });
    const result = f.fetch(PHOTO, { signal: controller.signal });
    await started;
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(body.destroyed).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each(['HEAD', 'RANGE'] as const)(
    'closes encoded %s metadata without reading or decoding',
    async (method) => {
      const f = fixture();
      let reads = 0;
      const body = new Readable({
        read() {
          reads += 1;
          this.push(Buffer.from('invalid gzip'));
        },
      });
      const close = jest.fn((error?: Error) => {
        body.destroy(error);
      });
      f.exchangePinned.mockResolvedValue({
        status: method === 'HEAD' ? 200 : 206,
        headers: new Headers({
          'content-encoding': 'gzip',
          'content-length': '12',
          'content-range': 'bytes 0-0/12',
        }),
        body,
        close,
      });
      const options =
        method === 'HEAD'
          ? { signal: f.signal, method: 'HEAD' as const }
          : { signal: f.signal, method: 'GET' as const, range: 'bytes=0-0' as const };
      const response = await f.fetch(PHOTO, options);
      await response.body?.cancel();
      await nextTurn();
      expect(reads).toBe(0);
      expect(response.body).toBeNull();
      expect(response.headers.get('content-length')).toBeNull();
      expect(response.headers.get('content-range')).toBeNull();
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  it('retains identity range metadata for the existing length checks', async () => {
    const f = fixture();
    f.exchangePinned.mockResolvedValue(
      exchange(206, { 'content-length': '1', 'content-range': 'bytes 0-0/345' }),
    );
    const response = await f.fetch(PHOTO, { signal: f.signal, range: 'bytes=0-0' });
    expect(response.headers.get('content-length')).toBe('1');
    expect(response.headers.get('content-range')).toBe('bytes 0-0/345');
    expect(response.body).toBeNull();
  });
});

class FakeRequest extends EventEmitter implements PublicMediaRequest {
  end = jest.fn<void, []>();
  private stopped = false;
  destroy = jest.fn((error?: Error) => {
    if (!this.stopped) {
      this.stopped = true;
      if (error) queueMicrotask(() => this.emit('error', error));
    }
    return this;
  });
}

describe('production pinned HTTPS exchange', () => {
  it('returns only the admitted address in both actual lookup callback forms', async () => {
    const request = new FakeRequest();
    const captured: RequestOptions[] = [];
    const incoming: PublicMediaIncomingMessage = Object.assign(
      Readable.from([Buffer.from([1, 2, 3])], { objectMode: false }),
      {
        statusCode: 200,
        rawHeaders: ['Content-Type', 'image/jpeg'],
      },
    );
    const factory: PublicMediaRequestFactory = (options, onResponse) => {
      captured.push(options);
      request.end.mockImplementation(() => onResponse(incoming));
      return request;
    };
    const f = fixture();
    const fetch = createPublicHttpsMediaFetcher({
      resolveAll: f.resolveAll,
      exchangePinned: createPinnedHttpsExchange(factory),
    });
    const response = await fetch(`${PHOTO}?version=2`, { signal: f.signal });
    const options = captured[0]!;
    expect(options).toMatchObject({
      hostname: 'cdn.vk.test',
      path: '/photo.jpg?version=2',
      port: 443,
      agent: false,
      servername: 'cdn.vk.test',
      rejectUnauthorized: true,
      headers: { 'Accept-Encoding': 'identity' },
    });
    expect(options.ca).toBeUndefined();
    if (!options.lookup) throw new Error('Production exchange did not install a pinned lookup');
    type Callback = Parameters<LookupFunction>[2];
    const single = jest.fn<ReturnType<Callback>, Parameters<Callback>>();
    const multiple = jest.fn<ReturnType<Callback>, Parameters<Callback>>();
    options.lookup('cdn.vk.test', { all: false }, single);
    options.lookup('cdn.vk.test', { all: true }, multiple);
    expect(single).toHaveBeenCalledWith(null, PUBLIC_V4.address, 4);
    expect(multiple).toHaveBeenCalledWith(null, [PUBLIC_V4]);
    expect(f.resolveAll).toHaveBeenCalledTimes(1);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
    expect(request.destroy).toHaveBeenCalledTimes(1);
  });

  it('aborts a connection waiting for TLS/headers through the original signal', async () => {
    const request = new FakeRequest();
    const controller = new AbortController();
    const factory: PublicMediaRequestFactory = () => request;
    const result = createPinnedHttpsExchange(factory)(new URL(PHOTO), PUBLIC_V4, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await nextTurn();
    expect(request.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps the actual request and incoming body cancellable after headers', async () => {
    const request = new FakeRequest();
    const controller = new AbortController();
    const incoming: PublicMediaIncomingMessage = Object.assign(new Readable({ read() {} }), {
      statusCode: 200,
      rawHeaders: ['Content-Type', 'image/jpeg'],
    });
    const factory: PublicMediaRequestFactory = (_, onResponse) => {
      request.end.mockImplementation(() => onResponse(incoming));
      return request;
    };
    const f = fixture();
    const fetch = createPublicHttpsMediaFetcher({
      resolveAll: f.resolveAll,
      exchangePinned: createPinnedHttpsExchange(factory),
    });
    const response = await fetch(PHOTO, { signal: controller.signal });
    const reader = response.body!.getReader();
    const reading = reader.read();
    controller.abort();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    reader.releaseLock();
    await nextTurn();
    expect(incoming.destroyed).toBe(true);
    expect(request.destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys a response arriving after its connection was abandoned', async () => {
    const request = new FakeRequest();
    const controller = new AbortController();
    let deliver: (response: PublicMediaIncomingMessage) => void = () => undefined;
    const factory: PublicMediaRequestFactory = (_, onResponse) => {
      deliver = onResponse;
      return request;
    };
    const result = createPinnedHttpsExchange(factory)(new URL(PHOTO), PUBLIC_V4, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    const incoming: PublicMediaIncomingMessage = Object.assign(new Readable({ read() {} }), {
      statusCode: 200,
      rawHeaders: [],
    });
    deliver(incoming);
    await nextTurn();
    expect(incoming.destroyed).toBe(true);
    expect(request.destroy).toHaveBeenCalledTimes(1);
  });

  it('omits DNS SNI for public IP literals and retains the exact metadata Range', async () => {
    const request = new FakeRequest();
    const captured: RequestOptions[] = [];
    const incoming: PublicMediaIncomingMessage = Object.assign(new Readable({ read() {} }), {
      statusCode: 206,
      rawHeaders: ['Content-Range', 'bytes 0-0/345'],
    });
    const factory: PublicMediaRequestFactory = (options, onResponse) => {
      captured.push(options);
      request.end.mockImplementation(() => onResponse(incoming));
      return request;
    };
    const f = fixture();
    const fetch = createPublicHttpsMediaFetcher({
      resolveAll: f.resolveAll,
      exchangePinned: createPinnedHttpsExchange(factory),
    });
    const response = await fetch('https://8.8.8.8/photo.jpg', {
      signal: f.signal,
      method: 'GET',
      range: 'bytes=0-0',
    });
    expect(captured[0]).toMatchObject({
      hostname: '8.8.8.8',
      servername: '',
      rejectUnauthorized: true,
      headers: { Range: 'bytes=0-0', 'Accept-Encoding': 'identity' },
    });
    expect(response.body).toBeNull();
    expect(response.headers.get('content-range')).toBe('bytes 0-0/345');
    expect(f.resolveAll).not.toHaveBeenCalled();
    expect(incoming.destroyed).toBe(true);
    expect(request.destroy).toHaveBeenCalledTimes(1);
  });

  it('preserves TLS rejection while omitting raw network error details', async () => {
    const factory: PublicMediaRequestFactory = () => {
      throw new Error('certificate failure with private diagnostic data');
    };
    const controller = new AbortController();
    await expect(
      createPinnedHttpsExchange(factory)(new URL(PHOTO), PUBLIC_V4, { signal: controller.signal }),
    ).rejects.toMatchObject({
      code: 'request_failed',
      message: 'Public HTTPS media request failed',
    });
  });
});
