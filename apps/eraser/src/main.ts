import pg from 'pg';
import { observePoolErrors } from './pool-errors.js';
import { Redis } from 'ioredis';
import { config } from './config.js';
import { Store } from './store.js';
import { HttpLimiter } from './limiter.js';
import { MaxClient } from './max.js';
import { CleanupRuntime } from './runtime.js';
import { createHttpServer } from './http.js';
import { DurableRateLimit } from './rate-limit.js';
import { startService } from './startup.js';

const settings = config();
const pool = new pg.Pool({
  connectionString: settings.databaseUrl,
  max: 4,
  connectionTimeoutMillis: 2000,
  application_name: 'lastik',
  options: '-c timezone=UTC -c statement_timeout=5000 -c lock_timeout=2000',
});
observePoolErrors(pool);
const redis = new Redis(settings.redisUrl, { maxRetriesPerRequest: 1 });
redis.on('error', () => {});
const store = new Store(pool, settings.enabled);
const startupAbort = new AbortController();
const max = new MaxClient(
  settings,
  new HttpLimiter(
    redis,
    settings.maxRps,
    'eraser:http',
    new DurableRateLimit(pool, settings.botId),
  ),
  undefined,
  undefined,
  startupAbort.signal,
);
const runtime = new CleanupRuntime(store, max, settings);
const server = createHttpServer(store, max, runtime, settings, () => redis.ping());
let observation: Promise<void> | undefined;
let observationTimer: ReturnType<typeof setInterval> | undefined;
function observeSubscription() {
  if (!observation && !startupAbort.signal.aborted) {
    observation = max.observeSubscription().finally(() => {
      observation = undefined;
    });
  }
}
let closing: Promise<void> | undefined;
let startup: Promise<boolean> | undefined;
function close(): Promise<void> {
  if (closing) return closing;
  startupAbort.abort();
  clearInterval(observationTimer);
  runtime.stopAdmission();
  closing = (async () => {
    const deadline = setTimeout(() => process.exit(1), 30_000);
    deadline.unref();
    try {
      await startup?.catch(() => {});
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.close();
      await observation;
      await redis.quit();
      await pool.end();
      clearTimeout(deadline);
    } catch {
      process.exitCode = 1;
    }
  })();
  return closing;
}
process.on('SIGTERM', () => {
  void close();
});
process.on('SIGINT', () => {
  void close();
});
try {
  startup = startService(
    {
      prepare: async () => {
        await pool.query('SELECT 1 FROM eraser_migrations LIMIT 1');
        await redis.ping();
      },
      listen: () =>
        new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(settings.port, '0.0.0.0', resolve);
        }),
      subscribe: async () => {
        if (settings.enabled) await max.subscribe();
      },
      start: async () => {
        await runtime.start();
        if (settings.enabled && !startupAbort.signal.aborted) {
          observeSubscription();
          observationTimer = setInterval(observeSubscription, 300_000);
          observationTimer.unref();
        }
      },
    },
    startupAbort.signal,
  );
  if (await startup)
    process.stdout.write(
      JSON.stringify({
        service: 'eraser',
        event: 'started',
        commitSha: settings.commitSha,
        enabled: settings.enabled,
      }) + '\n',
    );
} catch {
  const interrupted = startupAbort.signal.aborted;
  await close();
  if (!interrupted) {
    process.exitCode = 1;
    throw new Error('Eraser startup prerequisites unavailable');
  }
}
