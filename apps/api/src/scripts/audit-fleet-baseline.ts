import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { fleetBaselineCoverage } from '../system/fleet-baseline-coverage';
import { readMaxApiBaseline } from '../system/max-api-baseline-reader';
import { readStorageRuntimeFleet } from '../system/storage-runtime-metrics.service';

// FLAG: Run inside the existing admin container. No Nest bootstrap, workers,
// MAX calls, SQL, catalog bootstrap, keyspace scan or Redis writes are admitted.
async function main() {
  if (process.env.APP_ROLE !== 'admin' || !process.env.REDIS_URL)
    throw new Error('invalid_runtime');
  const args = process.argv.slice(2);
  let windowSec = 60;
  let untilMs: number | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (option === '--window-sec' && value && /^(60|120|300)$/u.test(value))
      windowSec = Number(value);
    else if (
      option === '--until' &&
      value &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:00Z$/u.test(value) &&
      new Date(value).toISOString().replace('.000Z', 'Z') === value
    )
      untilMs = Date.parse(value);
    else throw new Error('invalid_arguments');
  }
  const registry = new MaxBotRegistryService(new ConfigService(process.env));
  const botIds = [
    ...registry.getAllBots().map(({ id }) => id),
    registry.getPublisherBotDescriptor().id,
  ];
  const redis = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: 1_000,
    commandTimeout: 1_000,
  });
  redis.on('error', () => undefined);
  const hardDeadline = setTimeout(() => redis.disconnect(), 12_000);
  try {
    await redis.connect();
    const runtime = await readStorageRuntimeFleet(redis);
    const maxApi = await readMaxApiBaseline(redis, { botIds, windowSec, untilMs });
    const coverage = fleetBaselineCoverage(runtime, maxApi);
    const report = {
      schemaVersion: 1,
      observedAt: Date.now(),
      coverage,
      runtime,
      maxApi,
    };
    const output = JSON.stringify(report);
    if (Buffer.byteLength(output) > 512 * 1_024) throw new Error('output_limit');
    process.stdout.write(`${output}\n`);
    if (!coverage.collectionReady) process.exitCode = 1;
  } finally {
    clearTimeout(hardDeadline);
    redis.disconnect();
  }
}

void main().catch(() => {
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, available: false, code: 'collection_failed' })}\n`,
  );
  process.exitCode = 1;
});
