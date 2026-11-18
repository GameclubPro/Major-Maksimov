import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildSafetyDeskOverviewPendingIndexQuery,
  buildSafetyDeskOverviewPendingQuery,
} from './safety-desk-overview-pending.query';

const countSchema = z.number().int().nonnegative();
const actionWindowSchema = z.object({
  countLowerBound: countSchema.max(448),
  truncated: z.boolean(),
  oldestStateAt: z.string().datetime().nullable(),
});
const receiptWindowSchema = z.object({
  countLowerBound: countSchema.max(128),
  truncated: z.boolean(),
  oldestAt: z.string().datetime().nullable(),
});
const pendingSchema = z.object({
  observedAt: z.string().datetime(),
  invalidClocks: z.boolean(),
  unfinishedActions: actionWindowSchema,
  bots: z
    .array(
      z.object({
        botId: z.string().min(1).max(512),
        received: receiptWindowSchema,
        queued: receiptWindowSchema,
        unfinishedActions: actionWindowSchema,
      }),
    )
    .max(32),
});

export type SafetyDeskOverviewPendingSnapshot = Omit<
  z.infer<typeof pendingSchema>,
  'invalidClocks'
>;

export function indexPendingBots(
  bots: SafetyDeskOverviewPendingSnapshot['bots'],
  botIds: readonly string[],
) {
  const byId = new Map(bots.map((bot) => [bot.botId, bot]));
  if (bots.length !== botIds.length || botIds.some((botId) => !byId.has(botId))) {
    throw new Error('Incomplete pending bot catalog');
  }
  return byId;
}

@Injectable()
export class SafetyDeskOverviewPendingService {
  constructor(private readonly prisma: PrismaService) {}

  async getSnapshot(
    botIds: readonly string[],
    defaultBotId?: string | null,
  ): Promise<SafetyDeskOverviewPendingSnapshot> {
    try {
      const ids = z
        .array(z.string().min(1).max(512))
        .max(32)
        .parse([...new Set(botIds)]);
      if (defaultBotId && !ids.includes(defaultBotId)) throw new Error('Unknown default bot');
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          await tx.$executeRaw`SET LOCAL statement_timeout = '2000ms'`;
          await tx.$executeRaw`SET LOCAL lock_timeout = '250ms'`;
          await tx.$executeRaw`SET LOCAL max_parallel_workers_per_gather = 0`;
          await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
          const indexes = await tx.$queryRaw<Array<{ ready: boolean }>>(
            buildSafetyDeskOverviewPendingIndexQuery(),
          );
          if (indexes[0]?.ready !== true) throw new Error('Pending indexes unavailable');
          const rows = await tx.$queryRaw<Array<{ snapshot: unknown }>>(
            buildSafetyDeskOverviewPendingQuery(ids, defaultBotId ?? null),
          );
          const { invalidClocks, ...snapshot } = pendingSchema.parse(rows[0]?.snapshot);
          if (invalidClocks) throw new Error('Invalid pending clocks');
          indexPendingBots(snapshot.bots, ids);
          return snapshot;
        },
        { maxWait: 2_000, timeout: 5_000 },
      );
    } catch {
      // FLAG: Missing indexes, timed-out probes and invalid clocks are unavailable,
      // never empty queues. SQL/connection details cannot cross the owner API.
      throw new ServiceUnavailableException('Ожидающая работа временно недоступна.');
    }
  }
}
