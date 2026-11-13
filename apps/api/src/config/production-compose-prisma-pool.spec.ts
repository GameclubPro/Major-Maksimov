import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API_SERVICE_POOL_CAPS = {
  'api-ingress': 6,
  'api-admin': 10,
  'api-enqueue': 24,
  'api-moderation': 3,
  'api-moderation-critical': 4,
  'api-moderation-join': 4,
  'api-moderation-realtime-b': 3,
  'api-moderation-realtime-c': 3,
  'api-moderation-realtime-d': 3,
  'api-moderation-background': 2,
  'api-media-analysis': 2,
  'api-action': 4,
  'api-publisher': 2,
  'api-message-retention': 2,
} as const;

const API_SERVICE_POOL_CONNECTION_TIMEOUT_MS = {
  'api-action': 20_000,
  'api-publisher': 20_000,
} as const satisfies Partial<Record<keyof typeof API_SERVICE_POOL_CAPS, number>>;

const COMPOSE_FILES = [
  ['main', '../../../../infra/docker-compose.yml'],
  ['scale', '../../../../infra/docker-compose.scale.yml'],
] as const;

describe('production compose Prisma pool caps', () => {
  describe.each(COMPOSE_FILES)('%s compose', (_name, composePath) => {
    const compose = readFileSync(resolve(__dirname, composePath), 'utf8');

    it('caps every API role below the Postgres cold-start budget', () => {
      let total = 0;

      for (const [service, expectedCap] of Object.entries(API_SERVICE_POOL_CAPS)) {
        const block = readServiceBlock(compose, service);
        const cap = readEnvNumber(block, 'PRISMA_PG_POOL_MAX');
        expect(cap).toBe(expectedCap);
        expect(readEnvNumber(block, 'PRISMA_PG_POOL_IDLE_TIMEOUT_MS')).toBe(10_000);
        expect(readEnvNumber(block, 'PRISMA_PG_POOL_CONNECTION_TIMEOUT_MS')).toBe(
          API_SERVICE_POOL_CONNECTION_TIMEOUT_MS[
            service as keyof typeof API_SERVICE_POOL_CONNECTION_TIMEOUT_MS
          ] ?? 5_000,
        );
        total += cap;
      }

      expect(total).toBe(72);
    });

    it('caps the dedicated managed-entities read client separately', () => {
      const adminBlock = readServiceBlock(compose, 'api-admin');

      expect(readEnvNumber(adminBlock, 'MANAGED_ENTITIES_READ_PRISMA_PG_POOL_MAX')).toBe(6);
    });

    it('bounds main realtime and join templates independently from media and other roles', () => {
      const realtime = new Set([
        'api-moderation',
        'api-moderation-realtime-b',
        'api-moderation-realtime-c',
        'api-moderation-realtime-d',
      ]);
      for (const service of Object.keys(API_SERVICE_POOL_CAPS)) {
        const block = readServiceBlock(compose, service);
        const isRealtime = _name === 'main' && realtime.has(service);
        const isJoin = _name === 'main' && service === 'api-moderation-join';
        const expanded = isRealtime || isJoin;
        expect(readOptionalEnvNumber(block, 'CHAT_CONTEXT_SETTINGS_TEMPLATE_MAX_BYTES')).toBe(
          isRealtime ? 136 * 1024 * 1024 : isJoin ? 40 * 1024 * 1024 : null,
        );
        expect(readOptionalEnvNumber(block, 'CHAT_CONTEXT_SETTINGS_TEMPLATE_MAX_MEDIA_BYTES')).toBe(
          expanded ? 8 * 1024 * 1024 : null,
        );
        expect(readOptionalEnvNumber(block, 'CHAT_CONTEXT_SETTINGS_TEMPLATE_MAX_ENTRIES')).toBe(
          isRealtime ? 8192 : isJoin ? 2048 : null,
        );
      }
    });

    it('bounds long statements on the webhook ingress role only', () => {
      for (const service of Object.keys(API_SERVICE_POOL_CAPS)) {
        const block = readServiceBlock(compose, service);

        expect(readOptionalEnvNumber(block, 'PRISMA_PG_STATEMENT_TIMEOUT_MS')).toBe(
          service === 'api-ingress' ? 15_000 : service === 'api-message-retention' ? 2_000 : null,
        );
      }
    });

    it('keeps webhook outbox enqueue work owned by the enqueue role only', () => {
      for (const service of Object.keys(API_SERVICE_POOL_CAPS)) {
        const block = readServiceBlock(compose, service);
        const appRole = readEnvString(block, 'APP_ROLE');

        expect(appRole).not.toBe('all');
        expect(appRole === 'enqueue').toBe(service === 'api-enqueue');
      }
    });

    it('enables the host-pressure governor for every background worker owner', () => {
      for (const service of [
        'api-moderation-background',
        'api-action',
        'api-publisher',
        'api-message-retention',
      ] as const) {
        const block = readServiceBlock(compose, service);

        expect(readEnvString(block, 'BACKGROUND_GOVERNOR_SYSTEM_PRESSURE_ENABLED')).toBe('true');
        expect(readEnvNumber(block, 'BACKGROUND_GOVERNOR_SLOW_RETRY_AFTER_MS')).toBe(90_000);
        expect(readEnvNumber(block, 'BACKGROUND_GOVERNOR_PAUSE_RETRY_AFTER_MS')).toBe(180_000);
        expect(readEnvDecimal(block, 'BACKGROUND_GOVERNOR_IOWAIT_SLOW_THRESHOLD')).toBe(0.15);
        expect(readEnvDecimal(block, 'BACKGROUND_GOVERNOR_IOWAIT_PAUSE_THRESHOLD')).toBe(0.35);
      }
    });

    it('persists Redis /data on an explicit named volume', () => {
      const redisBlock = readServiceBlock(compose, 'redis');
      const volumesBlock = readTopLevelVolumesBlock(compose);

      expect(redisBlock).toMatch(/^\s{4}volumes:\n\s{6}- redis_data:\/data\s*$/mu);
      expect(volumesBlock).toMatch(/^\s{2}redis_data:\s*$/mu);
    });
  });
});

function readServiceBlock(compose: string, service: string): string {
  const match = compose.match(
    new RegExp(
      `\\n  ${escapeRegExp(service)}:\\n([\\s\\S]*?)(?=\\n  [a-zA-Z0-9_-]+:|\\nvolumes:|$)`,
      'u',
    ),
  );

  if (!match?.[1]) {
    throw new Error(`Missing compose service ${service}`);
  }

  return match[1];
}

function readTopLevelVolumesBlock(compose: string): string {
  const match = compose.match(/\nvolumes:\n([\s\S]*)$/u);

  if (!match?.[1]) {
    throw new Error('Missing top-level compose volumes block');
  }

  return match[1];
}

function readEnvNumber(serviceBlock: string, key: string): number {
  const value = readOptionalEnvNumber(serviceBlock, key);
  if (value === null) {
    throw new Error(`Missing compose env ${key}`);
  }

  return value;
}

function readOptionalEnvNumber(serviceBlock: string, key: string): number | null {
  const match = serviceBlock.match(
    new RegExp(`^\\s{6}${escapeRegExp(key)}:\\s*'?([0-9]+)'?\\s*$`, 'mu'),
  );

  if (!match?.[1]) {
    return null;
  }

  return Number(match[1]);
}

function readEnvString(serviceBlock: string, key: string): string {
  const match = serviceBlock.match(
    new RegExp(`^\\s{6}${escapeRegExp(key)}:\\s*'?([^'\\n]+)'?\\s*$`, 'mu'),
  );

  if (!match?.[1]) {
    throw new Error(`Missing compose env ${key}`);
  }

  return match[1].trim();
}

function readEnvDecimal(serviceBlock: string, key: string): number {
  const value = readEnvString(serviceBlock, key);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric compose env ${key}`);
  }
  return parsed;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
