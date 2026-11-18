import { once } from 'node:events';
import { createConnection, createServer, type Socket } from 'node:net';
import { raceWithTimeout } from '../../src/common/promise-timeout.util';

export function withinRetentionFixture<T>(stage: string, operation: Promise<T>) {
  return raceWithTimeout({
    operation,
    timeoutMs: 2_000,
    onTimeout: () => {
      throw new Error(`Retention test timed out waiting for ${stage}`);
    },
  });
}

// One private ioredis connection sends PING, then only the release under test.
export async function createRetentionReleasePeer(redisUrl: string) {
  const target = new URL(redisUrl);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
    target.protocol !== 'redis:'
  ) {
    throw new Error('Retention fixture requires a loopback Redis');
  }
  const upstreamAddress = {
    host: target.hostname.replace(/^\[|\]$/gu, ''),
    port: Number(target.port || 6379),
  };
  const sockets = new Set<Socket>();
  let connections = 0;
  let holdNextReply: (() => Promise<void>) | undefined;
  let discardHeldReply: (() => void) | undefined;
  const server = createServer((downstream) => {
    connections++;
    const upstream = createConnection(upstreamAddress);
    const closePair = () => {
      downstream.destroy();
      upstream.destroy();
    };
    for (const socket of [upstream, downstream]) {
      sockets.add(socket);
      socket.once('error', closePair);
      socket.once('close', () => {
        sockets.delete(socket);
        closePair();
      });
    }
    downstream.pipe(upstream);
    upstream.pipe(downstream);
    if (connections !== 1) return;

    holdNextReply = () => {
      upstream.unpipe(downstream);
      discardHeldReply = closePair;
      const expected = Buffer.from(':1\r\n');
      return new Promise<void>((resolve, reject) => {
        let bytes = 0;
        upstream.on('data', (chunk: Buffer) => {
          const next = bytes + chunk.length;
          if (next > expected.length || !expected.subarray(bytes, next).equals(chunk)) {
            reject(new Error('Expected one successful release on the private Redis connection'));
            return;
          }
          bytes = next;
          if (bytes === expected.length) resolve();
        });
        upstream.once('close', () => reject(new Error('Redis closed before confirming release')));
        upstream.resume();
      });
    };
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing retention fixture port');
  target.hostname = '127.0.0.1';
  target.port = String(address.port);
  return {
    url: target.href,
    get connections() {
      return connections;
    },
    holdReply() {
      if (!holdNextReply) throw new Error('Expected an initialized private Redis connection');
      const hold = holdNextReply;
      holdNextReply = undefined;
      return withinRetentionFixture('the first successful release response', hold());
    },
    discardReply() {
      if (!discardHeldReply) throw new Error('No release reply is held');
      discardHeldReply();
    },
    async close() {
      const closed = once(server, 'close');
      server.close();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}
