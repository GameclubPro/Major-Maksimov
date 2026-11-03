import { Redis } from 'ioredis';
import pg from 'pg';
import { config } from './config.js';
import { HttpLimiter } from './limiter.js';
import { MaxClient } from './max.js';
import { DurableRateLimit } from './rate-limit.js';

const settings = config();
if (
  !settings.webhookUrl ||
  !settings.botToken ||
  !settings.botId ||
  settings.webhookSecret.length < 32
)
  throw new Error('Webhook registration requires the configured bot, secret and HTTPS URL');
const redis = new Redis(settings.redisUrl, { maxRetriesPerRequest: 1 });
redis.on('error', () => {});
const pool = new pg.Pool({
  connectionString: settings.databaseUrl,
  max: 1,
  connectionTimeoutMillis: 2000,
  options: '-c timezone=UTC -c statement_timeout=5000 -c lock_timeout=2000',
});
try {
  const client = new MaxClient(
    settings,
    new HttpLimiter(
      redis,
      settings.maxRps,
      'eraser:http',
      new DurableRateLimit(pool, settings.botId),
    ),
  );
  const verification = await client.subscribe();
  process.stdout.write(
    verification.updateTypes === 'verified'
      ? 'Eraser webhook registration confirmed; update types: verified.\n'
      : 'Eraser webhook registration confirmed; update types: unknown (not reported by MAX).\n',
  );
} finally {
  try {
    await redis.quit();
  } finally {
    await pool.end();
  }
}
