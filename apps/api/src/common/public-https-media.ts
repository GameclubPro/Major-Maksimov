import { lookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Readable, type Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate, createInflateRaw } from 'node:zlib';

export type PublicHttpsMediaErrorCode =
  | 'url_invalid'
  | 'destination_denied'
  | 'dns_failed'
  | 'redirect_invalid'
  | 'redirect_limit'
  | 'redirect_loop'
  | 'response_invalid'
  | 'encoding_unsupported'
  | 'decoding_failed'
  | 'request_failed';

export class PublicHttpsMediaError extends Error {
  constructor(readonly code: PublicHttpsMediaErrorCode) {
    super('Public HTTPS media request failed');
    this.name = 'PublicHttpsMediaError';
  }
}

export interface PublicHttpsMediaOptions {
  signal: AbortSignal;
  method?: 'GET' | 'HEAD';
  range?: 'bytes=0-0';
}

export interface PublicMediaAddress {
  address: string;
  family: 4 | 6;
}

export interface PublicMediaExchange {
  status: number;
  headers: Headers;
  body: Readable;
  close(error?: Error): void;
}

export interface PublicHttpsMediaDependencies {
  resolveAll(host: string): Promise<readonly PublicMediaAddress[]>;
  exchangePinned(
    url: URL,
    address: PublicMediaAddress,
    options: PublicHttpsMediaOptions,
  ): Promise<PublicMediaExchange>;
}

export interface PublicMediaIncomingMessage extends Readable {
  statusCode?: number;
  rawHeaders: string[];
}

export interface PublicMediaRequest {
  once(event: 'error', listener: (error: Error) => void): unknown;
  end(): void;
  destroy(error?: Error): unknown;
}

export type PublicMediaRequestFactory = (
  options: RequestOptions,
  onResponse: (response: PublicMediaIncomingMessage) => void,
) => PublicMediaRequest;

const MAX_URL_BYTES = 8 * 1_024;
const MAX_REDIRECTS = 5;
const STREAM_HIGH_WATER_BYTES = 64 * 1_024;
const MAX_ENCODING_LAYERS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
const deniedV4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] satisfies Array<[string, number]>) {
  deniedV4.addSubnet(address, prefix, 'ipv4');
}
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const deniedV6 = new BlockList();
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] satisfies Array<[string, number]>) {
  deniedV6.addSubnet(address, prefix, 'ipv6');
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function normalizedFailure(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted) return abortError(signal);
  return error instanceof PublicHttpsMediaError
    ? error
    : new PublicHttpsMediaError('request_failed');
}

function hostnameOf(url: URL): string {
  return url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
}

function admittedUrl(input: string | URL, base?: URL): URL {
  try {
    const text = typeof input === 'string' ? input : input.href;
    if (Buffer.byteLength(text) > MAX_URL_BYTES) throw new Error();
    const authority = text.match(/^(?:https:)?\/\/([^/?#]*)/iu)?.[1];
    if (authority?.includes('@')) throw new Error();
    const url = new URL(text, base);
    const host = hostnameOf(url);
    const labels = host.replace(/\.$/u, '').split('.');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443') ||
      !host ||
      host.includes('%') ||
      (!isIP(host) &&
        (host.length > 253 ||
          labels.some((label) => !/^(?!-)[a-z0-9-]{1,63}(?<!-)$/iu.test(label)))) ||
      Buffer.byteLength(url.href) > MAX_URL_BYTES
    ) {
      throw new Error();
    }
    url.hash = '';
    return url;
  } catch {
    throw new PublicHttpsMediaError('url_invalid');
  }
}

function isPublicAddress(value: PublicMediaAddress): boolean {
  if (value.address.includes('%') || isIP(value.address) !== value.family) return false;
  // FLAG: This conservative public-media policy excludes special-purpose ranges and
  // transition tunnels, including IPv4-mapped IPv6; it is not a routability claim.
  return value.family === 4
    ? !deniedV4.check(value.address, 'ipv4')
    : value.family === 6 &&
        globalV6.check(value.address, 'ipv6') &&
        !deniedV6.check(value.address, 'ipv6');
}

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    // FLAG: DNS itself cannot be cancelled. Always adopt its late rejection while
    // the original signal refuses any connection after an abandoned lookup.
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function admitDestination(
  url: URL,
  dependencies: PublicHttpsMediaDependencies,
  signal: AbortSignal,
): Promise<PublicMediaAddress> {
  signal.throwIfAborted();
  const host = hostnameOf(url);
  const literalFamily = isIP(host);
  let addresses: readonly PublicMediaAddress[];
  if (literalFamily === 4 || literalFamily === 6) {
    addresses = [{ address: host, family: literalFamily }];
  } else {
    try {
      addresses = await withAbort(dependencies.resolveAll(host), signal);
    } catch (error: unknown) {
      if (signal.aborted) throw abortError(signal);
      if (error instanceof PublicHttpsMediaError) throw error;
      throw new PublicHttpsMediaError('dns_failed');
    }
  }
  signal.throwIfAborted();
  // FLAG: A mixed public/private answer is refused as a whole. The connection uses
  // exactly one admitted answer and never resolves the hostname a second time.
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw new PublicHttpsMediaError('destination_denied');
  }
  return addresses.find((address) => address.family === 4) ?? addresses[0]!;
}

export function createPinnedHttpsExchange(
  request: PublicMediaRequestFactory = (options, onResponse) => httpsRequest(options, onResponse),
): PublicHttpsMediaDependencies['exchangePinned'] {
  return (url, address, options) =>
    new Promise<PublicMediaExchange>((resolve, reject) => {
      options.signal.throwIfAborted();
      let pendingRequest: PublicMediaRequest | undefined;
      let body: PublicMediaIncomingMessage | undefined;
      let settled = false;
      let closed = false;
      const close = (error?: Error) => {
        if (closed) return;
        closed = true;
        options.signal.removeEventListener('abort', onAbort);
        body?.destroy(error);
        pendingRequest?.destroy(error);
      };
      const fail = (error: unknown) => {
        const failure = normalizedFailure(error, options.signal);
        if (!settled) {
          settled = true;
          reject(failure);
        }
        close(failure);
      };
      const onAbort = () => fail(abortError(options.signal));
      const pinnedLookup: LookupFunction = (_host, lookupOptions, callback) => {
        if (lookupOptions.all)
          callback(null, [{ address: address.address, family: address.family }]);
        else callback(null, address.address, address.family);
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
      try {
        const host = hostnameOf(url);
        pendingRequest = request(
          {
            protocol: 'https:',
            hostname: host,
            port: 443,
            path: `${url.pathname}${url.search}`,
            method: options.method ?? 'GET',
            headers: {
              'Accept-Encoding': 'identity',
              ...(options.range ? { Range: options.range } : {}),
            },
            // FLAG: Pin the actual socket, preserve the original TLS hostname and
            // normal CA checks, and disallow reuse of a previously pooled socket.
            lookup: pinnedLookup,
            agent: false,
            servername: isIP(host) ? '' : host,
            rejectUnauthorized: true,
            maxHeaderSize: 16 * 1_024,
          },
          (response) => {
            body = response;
            response.on('error', (error: Error) => fail(error));
            if (closed) {
              response.destroy();
              return;
            }
            try {
              const status = response.statusCode;
              if (
                status === undefined ||
                !Number.isInteger(status) ||
                status < 200 ||
                status > 599
              ) {
                throw new PublicHttpsMediaError('response_invalid');
              }
              const headers = new Headers();
              if (response.rawHeaders.length % 2 !== 0) {
                throw new PublicHttpsMediaError('response_invalid');
              }
              for (let index = 0; index < response.rawHeaders.length; index += 2) {
                headers.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
              }
              settled = true;
              resolve({ status, headers, body: response, close });
            } catch (error: unknown) {
              fail(error);
            }
          },
        );
        pendingRequest.once('error', fail);
        if (closed) pendingRequest.destroy();
        else pendingRequest.end();
      } catch (error: unknown) {
        fail(error);
      }
    });
}

function contentCodings(headers: Headers): string[] {
  const value = headers.get('content-encoding');
  if (!value?.trim()) return [];
  const codings = value.split(',').map((coding) => coding.trim().toLowerCase());
  if (
    codings.length > MAX_ENCODING_LAYERS ||
    codings.some((coding) => !['identity', 'gzip', 'deflate', 'br'].includes(coding))
  ) {
    throw new PublicHttpsMediaError('encoding_unsupported');
  }
  return codings.filter((coding) => coding !== 'identity').reverse();
}

function withoutEncodedLength(headers: Headers, encoded: boolean): Headers {
  const result = new Headers(headers);
  if (encoded) {
    result.delete('content-length');
    result.delete('content-range');
    result.delete('content-encoding');
  }
  return result;
}

async function deflateInput(source: Readable): Promise<{ input: Readable; decoder: Transform }> {
  const iterator: AsyncIterableIterator<unknown> = source[Symbol.asyncIterator]();
  const prefix: Buffer[] = [];
  let prefixLength = 0;
  while (prefixLength < 2) {
    const next = await iterator.next();
    if (next.done) throw new PublicHttpsMediaError('decoding_failed');
    if (!(next.value instanceof Uint8Array)) throw new PublicHttpsMediaError('decoding_failed');
    const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
    if (chunk.length > 0) {
      prefix.push(chunk);
      prefixLength += chunk.length;
    }
  }
  const first = prefix[0]![0]!;
  const second = prefix[0]!.length > 1 ? prefix[0]![1]! : prefix[1]![0]!;
  const zlibWrapped = (first & 15) === 8 && first >>> 4 <= 7 && ((first << 8) + second) % 31 === 0;
  // FLAG: Peek at most two nonempty chunks, then replay them into the streaming
  // decoder. A split zlib header must not turn the whole response into a buffer.
  const input = Readable.from(
    (async function* () {
      try {
        yield* prefix;
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          if (!(next.value instanceof Uint8Array)) {
            throw new PublicHttpsMediaError('decoding_failed');
          }
          yield next.value;
        }
      } finally {
        await iterator.return?.();
      }
    })(),
    { objectMode: false, highWaterMark: STREAM_HIGH_WATER_BYTES },
  );
  return { input, decoder: zlibWrapped ? createInflate() : createInflateRaw() };
}

async function decodedResponse(
  exchange: PublicMediaExchange,
  options: PublicHttpsMediaOptions,
): Promise<Response> {
  const streams = new Set<Readable>([exchange.body]);
  let ended = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const finish = (error?: Error) => {
    if (ended) return;
    ended = true;
    options.signal.removeEventListener('abort', onAbort);
    if (error) controller?.error(error);
    for (const stream of streams) stream.destroy(error);
    exchange.close(error);
  };
  const failDecode = () => {
    finish(
      options.signal.aborted
        ? abortError(options.signal)
        : new PublicHttpsMediaError('decoding_failed'),
    );
  };
  const onAbort = () => finish(abortError(options.signal));
  exchange.body.on('error', failDecode);
  options.signal.addEventListener('abort', onAbort, { once: true });
  try {
    options.signal.throwIfAborted();
    const codings = contentCodings(exchange.headers);
    const headers = withoutEncodedLength(exchange.headers, codings.length > 0);
    // FLAG: These calls read metadata only. Close the wire before constructing any
    // decoder; Web-stream pull prefetch must not download/decompress a Range probe.
    if (options.method === 'HEAD' || options.range || NULL_BODY_STATUSES.has(exchange.status)) {
      finish();
      return new Response(null, { status: exchange.status, headers });
    }
    let source = exchange.body;
    for (const coding of codings) {
      let input = source;
      let decoder: Transform;
      if (coding === 'deflate') {
        const deflate = await deflateInput(source);
        input = deflate.input;
        decoder = deflate.decoder;
        if (ended) {
          input.destroy();
          decoder.destroy();
          options.signal.throwIfAborted();
          throw new PublicHttpsMediaError('decoding_failed');
        }
        streams.add(input);
        input.on('error', failDecode);
      } else {
        decoder = coding === 'gzip' ? createGunzip() : createBrotliDecompress();
      }
      streams.add(decoder);
      decoder.on('error', failDecode);
      options.signal.throwIfAborted();
      source = input.pipe(decoder);
    }
    const iterator: AsyncIterableIterator<unknown> = source[Symbol.asyncIterator]();
    const body = new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value;
          if (ended)
            value.error(
              options.signal.aborted
                ? abortError(options.signal)
                : new PublicHttpsMediaError('decoding_failed'),
            );
        },
        async pull(value) {
          try {
            options.signal.throwIfAborted();
            const next = await iterator.next();
            if (ended) return;
            options.signal.throwIfAborted();
            if (next.done) {
              value.close();
              finish();
            } else if (next.value instanceof Uint8Array) {
              value.enqueue(next.value);
            } else {
              throw new PublicHttpsMediaError('decoding_failed');
            }
          } catch {
            failDecode();
          }
        },
        cancel() {
          finish();
        },
      },
      { highWaterMark: STREAM_HIGH_WATER_BYTES, size: (chunk) => chunk.byteLength },
    );
    return new Response(body, { status: exchange.status, headers });
  } catch (error: unknown) {
    const failure = options.signal.aborted
      ? abortError(options.signal)
      : error instanceof PublicHttpsMediaError
        ? error
        : new PublicHttpsMediaError('decoding_failed');
    finish(failure);
    throw failure;
  }
}

export function createPublicHttpsMediaFetcher(dependencies: PublicHttpsMediaDependencies) {
  return async (input: string | URL, options: PublicHttpsMediaOptions): Promise<Response> => {
    options.signal.throwIfAborted();
    if (
      (options.method !== undefined && options.method !== 'GET' && options.method !== 'HEAD') ||
      (options.range !== undefined && options.range !== 'bytes=0-0') ||
      (options.range !== undefined && options.method === 'HEAD')
    ) {
      throw new PublicHttpsMediaError('request_failed');
    }
    let url = admittedUrl(input);
    const visited = new Set<string>();
    for (let redirects = 0; ; redirects += 1) {
      if (visited.has(url.href)) throw new PublicHttpsMediaError('redirect_loop');
      visited.add(url.href);
      const address = await admitDestination(url, dependencies, options.signal);
      options.signal.throwIfAborted();
      let exchange: PublicMediaExchange;
      try {
        exchange = await dependencies.exchangePinned(url, address, options);
      } catch (error: unknown) {
        throw normalizedFailure(error, options.signal);
      }
      if (!REDIRECT_STATUSES.has(exchange.status)) return decodedResponse(exchange, options);
      exchange.close();
      options.signal.throwIfAborted();
      if (redirects >= MAX_REDIRECTS) throw new PublicHttpsMediaError('redirect_limit');
      const location = exchange.headers.get('location');
      if (!location || Buffer.byteLength(location) > MAX_URL_BYTES) {
        throw new PublicHttpsMediaError('redirect_invalid');
      }
      url = admittedUrl(location, url);
    }
  };
}

export const fetchPublicHttpsMedia = createPublicHttpsMediaFetcher({
  resolveAll: async (host) => {
    const addresses = await lookup(host, { all: true, verbatim: true });
    return addresses.map((address): PublicMediaAddress => {
      if (address.family !== 4 && address.family !== 6) {
        throw new PublicHttpsMediaError('destination_denied');
      }
      return { address: address.address, family: address.family };
    });
  },
  exchangePinned: createPinnedHttpsExchange(),
});
