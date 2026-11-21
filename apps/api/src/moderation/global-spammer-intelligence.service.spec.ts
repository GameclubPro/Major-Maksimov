import type { ConfigService } from '@nestjs/config';
import { GlobalSpammerIntelligenceService } from './global-spammer-intelligence.service';
import {
  buildGlobalSpammerDenormDeduplicationId,
  GLOBAL_SPAMMER_DENORM_JOB_NAME,
} from './global-spammer-denorm.queue';

function createConfigMock(values: Record<string, string | undefined>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function createPrismaMock() {
  const registry = new Map<string, any>();
  const observations: any[] = [];
  const candidates = new Map<string, any>();
  const candidateChats = new Map<string, any>();
  const suppressions: any[] = [];
  const localAdminDecisions: any[] = [];
  const chatAdminAllowlistRows: any[] = [];
  const campaignClusters: any[] = [];
  const campaignMembers: any[] = [];
  const shadowScores: any[] = [];
  const reviewFeedback: any[] = [];
  const runtimeProfiles = new Map<string, any>();
  const applySelect = (row: any, select: any) => {
    if (!select) {
      return row;
    }
    return Object.fromEntries(
      Object.entries(select)
        .filter(([, enabled]) => enabled)
        .map(([key]) => [key, row[key]]),
    );
  };
  const applyData = (row: any, data: any) => {
    const next = { ...row };
    for (const [key, value] of Object.entries(data ?? {})) {
      if (value && typeof value === 'object' && !Array.isArray(value) && 'increment' in value) {
        next[key] = (next[key] ?? 0) + Number((value as { increment: number }).increment);
      } else {
        next[key] = value;
      }
    }
    return next;
  };
  const globalSpammer = {
    upsert: jest.fn(async (args: any) => {
      const userId = args.where.userId;
      const existing = registry.get(userId);
      const next = {
        ...(existing ?? {}),
        ...(existing ? applyData(existing, args.update) : args.create),
        userId,
      };
      registry.set(userId, next);
      return next;
    }),
    deleteMany: jest.fn(async ({ where }: any) => {
      if (where?.userId?.in) {
        let count = 0;
        for (const userId of where.userId.in) {
          if (registry.delete(userId)) {
            count += 1;
          }
        }
        return { count };
      }
      if (where?.userId) {
        return { count: registry.delete(where.userId) ? 1 : 0 };
      }
      return { count: 0 };
    }),
    findUnique: jest.fn(async ({ where }: any) => registry.get(where.userId) ?? null),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  };
  const globalSpammerArchive = {
    createMany: jest.fn().mockResolvedValue({ count: 0 }),
    count: jest.fn().mockResolvedValue(0),
  };
  const globalSpammerCandidate = {
    upsert: jest.fn(async (args: any) => {
      const userId = args.where.userId;
      const existing = candidates.get(userId);
      const next = {
        ...(existing ?? {}),
        ...(existing ? args.update : args.create),
        userId,
      };
      candidates.set(userId, next);
      return next;
    }),
    update: jest.fn(async (args: any) => {
      const existing = candidates.get(args.where.userId) ?? { userId: args.where.userId };
      const next = { ...existing, ...args.data };
      candidates.set(args.where.userId, next);
      return next;
    }),
    updateMany: jest.fn(async (args: any) => {
      const userId = args.where.userId;
      const existing = candidates.get(userId);
      if (!existing) {
        return { count: 0 };
      }
      candidates.set(userId, { ...existing, ...args.data });
      return { count: 1 };
    }),
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn(async ({ where }: any) => candidates.get(where.userId) ?? null),
    count: jest.fn().mockResolvedValue(0),
  };
  const globalSpammerCandidateChat = {
    upsert: jest.fn(async ({ where, create, update }: any) => {
      const key = `${where.candidateUserId_chatId.candidateUserId}:${where.candidateUserId_chatId.chatId}`;
      const existing = candidateChats.get(key);
      const next = {
        ...(existing ?? {}),
        ...(existing ? applyData(existing, update) : create),
      };
      candidateChats.set(key, next);
      return next;
    }),
  };
  const globalSpammerSuppression = {
    findFirst: jest.fn(async ({ where }: any) => {
      const now = where.suppressedUntil.gt as Date;
      return (
        suppressions.find((row) => row.userId === where.userId && row.suppressedUntil > now) ?? null
      );
    }),
    create: jest.fn(async ({ data }: any) => {
      suppressions.push(data);
      return data;
    }),
  };
  const spammerGraphSignalRows: any[] = [];
  const spammerGraphSignal = {
    upsert: jest.fn(async ({ where, create, update }: any) => {
      const index = spammerGraphSignalRows.findIndex((row) => row.signalKey === where.signalKey);
      const next = {
        id: spammerGraphSignalRows[index]?.id ?? `graph-${spammerGraphSignalRows.length + 1}`,
        ...(index >= 0 ? spammerGraphSignalRows[index] : {}),
        ...(index >= 0 ? update : create),
      };
      if (index >= 0) {
        spammerGraphSignalRows[index] = next;
      } else {
        spammerGraphSignalRows.push(next);
      }
      return next;
    }),
    findMany: jest.fn(async ({ where }: any) =>
      spammerGraphSignalRows
        .filter(
          (row) =>
            (!where.userId || row.userId === where.userId) &&
            (!where.signalType || row.signalType === where.signalType) &&
            (!where.signalHash || row.signalHash === where.signalHash) &&
            (!where.expiresAt?.gt || row.expiresAt > where.expiresAt.gt),
        )
        .slice(0, 200),
    ),
  };
  const globalSpammerEnforcementDecision = {
    create: jest.fn().mockResolvedValue({}),
  };
  const chat = {
    findUnique: jest.fn().mockResolvedValue(null),
  };
  const chatAdminAllowlist = {
    findMany: jest.fn(async ({ where }: any) =>
      chatAdminAllowlistRows
        .filter((row) => !where?.chatId || row.chatId === where.chatId)
        .map((row) => ({ userId: row.userId })),
    ),
  };
  const adminGlobalSpammerExemption = {
    findFirst: jest.fn(async ({ where }: any) => {
      const userId = where?.userId;
      return localAdminDecisions.find((row) => row.userId === userId) ?? null;
    }),
    findMany: jest.fn(async ({ where, orderBy, take }: any) => {
      let rows = localAdminDecisions.filter((row) => {
        if (where?.adminUserId?.in && !where.adminUserId.in.includes(row.adminUserId)) {
          return false;
        }
        if (where?.userId?.in && !where.userId.in.includes(row.userId)) {
          return false;
        }
        return true;
      });
      if (orderBy?.updatedAt === 'desc') {
        rows = rows.sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
      }
      return typeof take === 'number' ? rows.slice(0, take) : rows;
    }),
    upsert: jest.fn(async ({ where, create, update }: any) => {
      const key = where.adminUserId_userId;
      const index = localAdminDecisions.findIndex(
        (row) => row.adminUserId === key.adminUserId && row.userId === key.userId,
      );
      const now = new Date();
      const next = {
        ...(index >= 0 ? localAdminDecisions[index] : {}),
        ...(index >= 0 ? update : create),
        adminUserId: key.adminUserId,
        userId: key.userId,
        updatedAt: now,
      };
      if (index >= 0) {
        localAdminDecisions[index] = next;
      } else {
        localAdminDecisions.push(next);
      }
      return next;
    }),
  };
  const spammerObservation = {
    upsert: jest.fn(async ({ where, create, update }: any) => {
      const key = where.userId_source_evidenceHash;
      const index = observations.findIndex(
        (row) =>
          row.userId === key.userId &&
          row.source === key.source &&
          row.evidenceHash === key.evidenceHash,
      );
      const next = {
        id: observations[index]?.id ?? create.id ?? `obs-${observations.length + 1}`,
        ...(index >= 0 ? observations[index] : {}),
        ...(index >= 0 ? update : create),
        userId: key.userId,
        source: key.source,
        evidenceHash: key.evidenceHash,
      };
      if (index >= 0) {
        observations[index] = next;
      } else {
        observations.push(next);
      }
      return next;
    }),
    findMany: jest.fn(async ({ where, orderBy, take, select }: any) => {
      let rows = observations.filter((row) => {
        if (where.userId?.in && !where.userId.in.includes(row.userId)) {
          return false;
        }
        if (typeof where.userId === 'string' && row.userId !== where.userId) {
          return false;
        }
        if (typeof where.id === 'string' && row.id !== where.id) {
          return false;
        }
        if (where.expiresAt?.gt && !(row.expiresAt > where.expiresAt.gt)) {
          return false;
        }
        if ('suppressedAt' in where && row.suppressedAt !== where.suppressedAt) {
          return false;
        }
        if (
          where.rawEvidenceExpiresAt?.lte &&
          !(row.rawEvidenceExpiresAt && row.rawEvidenceExpiresAt <= where.rawEvidenceExpiresAt.lte)
        ) {
          return false;
        }
        if (where.privacyClass?.not && row.privacyClass === where.privacyClass.not) {
          return false;
        }
        return true;
      });
      if (orderBy?.observedAt === 'desc') {
        rows = rows.sort((left, right) => right.observedAt.getTime() - left.observedAt.getTime());
      }
      if (Array.isArray(orderBy) && orderBy.some((item) => item.rawEvidenceExpiresAt === 'asc')) {
        rows = rows.sort(
          (left, right) =>
            (left.rawEvidenceExpiresAt?.getTime() ?? 0) -
            (right.rawEvidenceExpiresAt?.getTime() ?? 0),
        );
      }
      const limitedRows = typeof take === 'number' ? rows.slice(0, take) : rows;
      return limitedRows.map((row) => applySelect(row, select));
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const index = observations.findIndex((row) => row.id === where.id);
      if (index < 0) {
        throw new Error(`Observation ${where.id} not found`);
      }
      observations[index] = { ...observations[index], ...data };
      return observations[index];
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const row of observations) {
        if (typeof where.id === 'string') {
          const remainsPrunable =
            where.rawEvidenceExpiresAt?.lte &&
            row.updatedAt?.getTime() === where.updatedAt?.getTime() &&
            row.privacyClass !== 'MINIMIZED' &&
            row.rawEvidenceExpiresAt &&
            row.rawEvidenceExpiresAt <= where.rawEvidenceExpiresAt.lte;
          if (
            row.id === where.id &&
            (where.rawEvidenceExpiresAt ? remainsPrunable : row.projectionDueAt != null)
          ) {
            Object.assign(row, data);
            count++;
          }
          continue;
        }
        if (
          row.userId === where.userId &&
          row.expiresAt > where.expiresAt.gt &&
          row.suppressedAt === null
        ) {
          Object.assign(row, data);
          count += 1;
        }
      }
      return { count };
    }),
    count: jest.fn(
      async ({ where }: any) =>
        observations.filter((row) => {
          if (typeof where.userId === 'string' && row.userId !== where.userId) {
            return false;
          }
          if (typeof where.chatId === 'string' && row.chatId !== where.chatId) {
            return false;
          }
          if (where.expiresAt?.gt && !(row.expiresAt > where.expiresAt.gt)) {
            return false;
          }
          if ('suppressedAt' in where && row.suppressedAt !== where.suppressedAt) {
            return false;
          }
          return true;
        }).length,
    ),
    groupBy: jest.fn().mockResolvedValue([]),
  };
  const spammerCampaignCluster = {
    upsert: jest.fn(async ({ where, create, update }: any) => {
      const index = campaignClusters.findIndex((row) => row.clusterKey === where.clusterKey);
      const now = new Date();
      const next = {
        id: campaignClusters[index]?.id ?? `cluster-${campaignClusters.length + 1}`,
        createdAt: campaignClusters[index]?.createdAt ?? now,
        updatedAt: now,
        ...(index >= 0 ? campaignClusters[index] : {}),
        ...(index >= 0 ? applyData(campaignClusters[index], update) : create),
      };
      if (index >= 0) {
        campaignClusters[index] = next;
      } else {
        campaignClusters.push(next);
      }
      return next;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const index = campaignClusters.findIndex((row) => row.id === where.id);
      if (index < 0) {
        throw new Error(`Campaign cluster ${where.id} not found`);
      }
      campaignClusters[index] = applyData(campaignClusters[index], {
        ...data,
        updatedAt: new Date(),
      });
      return campaignClusters[index];
    }),
    findMany: jest.fn(async ({ where, take }: any) => {
      let rows = campaignClusters.filter((row) => {
        if (where?.lastSeenAt?.gte && !(row.lastSeenAt >= where.lastSeenAt.gte)) {
          return false;
        }
        if (where?.members?.some?.chatId) {
          return campaignMembers.some(
            (member) => member.clusterId === row.id && member.chatId === where.members.some.chatId,
          );
        }
        return true;
      });
      rows = rows.sort(
        (left, right) =>
          (right.confidenceScore ?? 0) - (left.confidenceScore ?? 0) ||
          (right.observationsCount ?? 0) - (left.observationsCount ?? 0) ||
          (right.lastSeenAt?.getTime() ?? 0) - (left.lastSeenAt?.getTime() ?? 0),
      );
      return typeof take === 'number' ? rows.slice(0, take) : rows;
    }),
  };
  const spammerCampaignClusterMember = {
    upsert: jest.fn(async ({ where, create, update }: any) => {
      const key = where.clusterId_userId;
      const index = campaignMembers.findIndex(
        (row) => row.clusterId === key.clusterId && row.userId === key.userId,
      );
      const next = {
        ...(index >= 0 ? campaignMembers[index] : {}),
        ...(index >= 0 ? applyData(campaignMembers[index], update) : create),
      };
      if (index >= 0) {
        campaignMembers[index] = next;
      } else {
        campaignMembers.push(next);
      }
      return next;
    }),
    findMany: jest.fn(async ({ where, select, include, take }: any) => {
      let rows = campaignMembers.filter((row) => {
        if (where.clusterId && row.clusterId !== where.clusterId) {
          return false;
        }
        if (where.userId && row.userId !== where.userId) {
          return false;
        }
        return true;
      });
      rows = rows.sort(
        (left, right) => (right.lastSeenAt?.getTime() ?? 0) - (left.lastSeenAt?.getTime() ?? 0),
      );
      if (include?.cluster) {
        rows = rows.map((row) => ({
          ...row,
          cluster: campaignClusters.find((cluster) => cluster.id === row.clusterId),
        }));
      }
      if (select?.userId || select?.chatId) {
        rows = rows.map((row) => ({
          ...(select.userId ? { userId: row.userId } : {}),
          ...(select.chatId ? { chatId: row.chatId } : {}),
        }));
      }
      return typeof take === 'number' ? rows.slice(0, take) : rows;
    }),
  };
  const globalSpammerShadowScore = {
    create: jest.fn(async ({ data }: any) => {
      const row = {
        id: `shadow-${shadowScores.length + 1}`,
        createdAt: new Date(),
        humanReviewOutcome: null,
        reviewedAt: null,
        reviewedByUserId: null,
        ...data,
      };
      shadowScores.push(row);
      return row;
    }),
    count: jest.fn(
      async ({ where }: any) =>
        shadowScores.filter(
          (row) =>
            (!where.createdAt?.gte || row.createdAt >= where.createdAt.gte) &&
            (!('wouldPromote' in where) || row.wouldPromote === where.wouldPromote) &&
            (!where.chatId || row.chatId === where.chatId),
        ).length,
    ),
    findFirst: jest.fn(
      async ({ where }: any) =>
        [...shadowScores]
          .filter(
            (row) =>
              row.userId === where.userId &&
              (!where.observationId || row.observationId === where.observationId),
          )
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null,
    ),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const row of shadowScores) {
        if (
          row.userId === where.userId &&
          (!('humanReviewOutcome' in where) || row.humanReviewOutcome === where.humanReviewOutcome)
        ) {
          Object.assign(row, data);
          count += 1;
        }
      }
      return { count };
    }),
  };
  const globalSpammerReviewFeedback = {
    create: jest.fn(async ({ data }: any) => {
      const row = {
        id: `feedback-${reviewFeedback.length + 1}`,
        createdAt: new Date(),
        ...data,
      };
      reviewFeedback.push(row);
      return row;
    }),
  };
  const globalSpammerRuntimeProfile = {
    findUnique: jest.fn(async ({ where }: any) => runtimeProfiles.get(where.userId) ?? null),
    upsert: jest.fn(async ({ where, create, update }: any) => {
      const existing = runtimeProfiles.get(where.userId);
      const now = new Date();
      const next = {
        ...(existing ?? {}),
        ...(existing ? update : create),
        userId: where.userId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      runtimeProfiles.set(where.userId, next);
      return next;
    }),
  };

  return {
    registry,
    observations,
    candidates,
    candidateChats,
    campaignClusters,
    campaignMembers,
    shadowScores,
    reviewFeedback,
    runtimeProfiles,
    localAdminDecisions,
    chatAdminAllowlistRows,
    spammerGraphSignalRows,
    prisma: {
      chat,
      chatAdminAllowlist,
      adminGlobalSpammerExemption,
      spammerObservation,
      spammerGraphSignal,
      globalSpammer,
      globalSpammerArchive,
      globalSpammerCandidate,
      globalSpammerCandidateChat,
      globalSpammerSuppression,
      globalSpammerEnforcementDecision,
      spammerCampaignCluster,
      spammerCampaignClusterMember,
      globalSpammerShadowScore,
      globalSpammerReviewFeedback,
      globalSpammerRuntimeProfile,
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
    },
  };
}

function readSpammerL1State(service: GlobalSpammerIntelligenceService) {
  return service as unknown as {
    runtimeProfileL1Cache: Map<string, { snapshot: unknown; expiresAtMs: number }>;
    runtimeProfileL1SweepIterator: IterableIterator<unknown> | null;
    runtimeProfileL1SweepRemaining: number;
    runtimeProfileL1SweepTimer: NodeJS.Timeout | null;
    writeRuntimeProfileToL1(userId: string, snapshot: null): void;
    readRuntimeProfileFromL1(userId: string): unknown;
  };
}

describe('GlobalSpammerIntelligenceService', () => {
  describe('permanent legacy global-user hold', () => {
    function fixture() {
      const { prisma } = createPrismaMock();
      const isGlobalUserHeld = jest.fn().mockResolvedValue(true);
      const service = new GlobalSpammerIntelligenceService(
        prisma as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { isGlobalUserHeld } as never,
      );
      return { prisma, service, isGlobalUserHeld };
    }

    it('denies old reputation before any cached policy or new observation', async () => {
      const { prisma, service } = fixture();
      const result = await service.evaluatePolicy({
        userId: 'held-user',
        chatId: 'other-chat',
        trigger: 'message',
        deleteSpammersEnabled: true,
      });
      expect(result).toMatchObject({ action: 'NONE', reason: 'LEGACY_USER_EFFECT_HELD' });
      await service.recordObservation({
        userId: 'held-user',
        chatId: 'original-chat',
        source: 'SANCTION_BAN',
        score: 1,
        reason: 'Legacy unconfirmed BAN',
      });
      expect(prisma.globalSpammer.findUnique).not.toHaveBeenCalled();
      expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
      expect(prisma.spammerObservation.upsert).not.toHaveBeenCalled();
    });

    it('denies an already stored denormalization job without rewriting its evidence/profile', async () => {
      const { prisma, service } = fixture();
      await service.processObservationDenormJob({
        userId: 'held-user',
        chatId: 'original-chat',
        observationId: 'old-observation',
        source: 'SANCTION_BAN',
        reason: 'Legacy',
      } as never);
      expect(prisma.globalSpammer.findUnique).not.toHaveBeenCalled();
      expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
      expect(prisma.globalSpammerRuntimeProfile.upsert).not.toHaveBeenCalled();
    });

    it('fails closed when durable hold storage is unavailable', async () => {
      const { prisma, service, isGlobalUserHeld } = fixture();
      isGlobalUserHeld.mockRejectedValue(new Error('Hold store unavailable'));
      await expect(
        service.evaluatePolicy({
          userId: 'held-user',
          chatId: 'other-chat',
          trigger: 'message',
          deleteSpammersEnabled: true,
        }),
      ).rejects.toThrow('Hold store unavailable');
      await expect(
        service.recordObservation({
          userId: 'held-user',
          source: 'SANCTION_BAN',
          score: 1,
          reason: 'Legacy',
        }),
      ).rejects.toThrow('Hold store unavailable');
      expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
    });
  });

  describe('bounded runtime profile L1 lifecycle', () => {
    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-01T13:00:00.000Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('releases idle profiles in bounded callbacks without querying Redis or Postgres', async () => {
      const { prisma } = createPrismaMock();
      const service = new GlobalSpammerIntelligenceService(prisma as never);
      const state = readSpammerL1State(service);
      for (let index = 0; index < 8192; index++) {
        state.writeRuntimeProfileToL1(`idle-${index}`, null);
      }
      expect(state.runtimeProfileL1SweepTimer?.hasRef()).toBe(false);
      await jest.advanceTimersByTimeAsync(5000);
      expect(state.runtimeProfileL1Cache.size).toBe(8192 - 256);
      await jest.advanceTimersByTimeAsync(100);
      expect(state.runtimeProfileL1Cache.size).toBe(0);
      expect(state.runtimeProfileL1SweepIterator).toBeNull();
      expect(state.runtimeProfileL1SweepTimer).toBeNull();
      expect(prisma.globalSpammerRuntimeProfile.findUnique).not.toHaveBeenCalled();
      service.onModuleDestroy();
    });

    it('preserves refreshed negative entries until their original TTL expires', async () => {
      const { prisma } = createPrismaMock();
      const service = new GlobalSpammerIntelligenceService(prisma as never);
      const state = readSpammerL1State(service);
      state.writeRuntimeProfileToL1('old-negative', null);
      state.writeRuntimeProfileToL1('refreshed-negative', null);
      await jest.advanceTimersByTimeAsync(4000);
      state.writeRuntimeProfileToL1('refreshed-negative', null);
      await jest.advanceTimersByTimeAsync(1000);
      expect(state.readRuntimeProfileFromL1('old-negative')).toBeUndefined();
      expect(state.readRuntimeProfileFromL1('refreshed-negative')).toBeNull();
      await jest.advanceTimersByTimeAsync(4000);
      expect(state.readRuntimeProfileFromL1('refreshed-negative')).toBeUndefined();
      service.onModuleDestroy();
    });

    it('bounds disposable profiles, protects refreshed keys and reloads an evicted profile from the authoritative read model', async () => {
      const { prisma, runtimeProfiles } = createPrismaMock();
      const service = new GlobalSpammerIntelligenceService(
        prisma as never,
        createConfigMock({
          SPAMMER_PROFILE_CACHE_ENABLED: 'true',
          SPAMMER_READ_MODEL_ENFORCEMENT_ENABLED: 'true',
        }),
      );
      const state = readSpammerL1State(service);
      for (let index = 0; index < 10000; index++) {
        state.writeRuntimeProfileToL1(`user-${index}`, null);
      }
      state.writeRuntimeProfileToL1('user-0', null);
      state.writeRuntimeProfileToL1('overflow-user', null);
      expect(state.runtimeProfileL1Cache.size).toBe(10000);
      expect(state.readRuntimeProfileFromL1('user-0')).toBeNull();
      expect(state.readRuntimeProfileFromL1('user-1')).toBeUndefined();
      runtimeProfiles.set('user-1', {
        userId: 'user-1',
        registryStatus: 'ACTIVE_CONFIRMED',
        action: 'DELETE_AND_KICK',
        confidenceScore: 0.97,
        shadowScore: null,
        policyBand: 'CONFIRMED',
        reason: 'REVIEW_APPROVED',
        expiresAt: new Date(Date.now() + 60000),
        suppressedUntil: null,
        sourceBreakdown: { REVIEW_APPROVED: { score: 1 } },
        campaignBreakdown: null,
        sourceVersion: 3,
        staleAfter: new Date(Date.now() + 60000),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await expect(
        service.evaluatePolicy({
          chatId: 'chat-1',
          userId: 'user-1',
          trigger: 'message',
          deleteSpammersEnabled: true,
          recordDecision: false,
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          registryStatus: 'ACTIVE_CONFIRMED',
          action: 'DELETE_AND_KICK',
          reason: 'REVIEW_APPROVED',
        }),
      );
      expect(prisma.globalSpammerRuntimeProfile.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.globalSpammerRuntimeProfile.findUnique).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });
      expect(prisma.globalSpammer.findUnique).not.toHaveBeenCalled();
      expect(state.runtimeProfileL1Cache.size).toBe(10000);
      service.onModuleDestroy();
    });

    it('finishes an expiry pass under continuing churn and stops during shutdown', async () => {
      const { prisma } = createPrismaMock();
      const service = new GlobalSpammerIntelligenceService(prisma as never);
      const state = readSpammerL1State(service);
      for (let index = 0; index < 512; index++) {
        state.writeRuntimeProfileToL1(`initial-${index}`, null);
      }
      await jest.advanceTimersByTimeAsync(5000);
      expect(state.runtimeProfileL1SweepRemaining).toBe(256);
      for (let index = 0; index < 512; index++) {
        state.writeRuntimeProfileToL1(`new-${index}`, null);
      }
      await jest.advanceTimersByTimeAsync(1);
      expect(state.runtimeProfileL1SweepIterator).toBeNull();
      expect(state.runtimeProfileL1Cache.size).toBe(512);
      await jest.advanceTimersByTimeAsync(5000);
      expect(state.runtimeProfileL1SweepIterator).not.toBeNull();
      service.onModuleDestroy();
      expect(state.runtimeProfileL1Cache.size).toBe(0);
      expect(state.runtimeProfileL1SweepIterator).toBeNull();
      expect(state.runtimeProfileL1SweepTimer).toBeNull();
      state.writeRuntimeProfileToL1('late-after-shutdown', null);
      await jest.advanceTimersByTimeAsync(60000);
      expect(state.runtimeProfileL1Cache.size).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  it('ignores spammer observations and enforcement for configured bot users', async () => {
    const { prisma } = createPrismaMock();
    const maxBotRegistry = {
      isKnownBotUserId: jest.fn((userId: string | null | undefined) => userId === '613002203036_5'),
    };
    const service = new GlobalSpammerIntelligenceService(
      prisma as never,
      undefined,
      maxBotRegistry as never,
    );

    const result = await service.recordObservation({
      userId: '613002203036_5',
      source: 'FANOUT_HIGH',
      score: 0.99,
      reason: 'FANOUT_EPISODE_CONFIRMED',
      chatId: 'chat-1',
      evidence: { uniqueChats: 10 },
      forceRegistry: true,
    });

    expect(result.outcome).toBe('ignored');
    expect(prisma.spammerObservation.upsert).not.toHaveBeenCalled();
    expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();

    await prisma.globalSpammer.upsert({
      where: { userId: '613002203036_5' },
      create: {
        userId: '613002203036_5',
        confidenceScore: 1,
        lastReason: 'legacy-row',
        sourceBreakdown: {},
        expiresAt: new Date(Date.now() + 60_000),
      },
      update: {},
    });

    await expect(
      service.evaluatePolicy({
        chatId: 'chat-1',
        userId: '613002203036_5',
        trigger: 'message',
        deleteSpammersEnabled: true,
        recordDecision: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        action: 'NONE',
        reason: 'KNOWN_RUNTIME_BOT',
      }),
    );
  });

  it.each([
    { DEVELOPER_FORCED: { score: 1 } },
    { DEVELOPER_FORCED: { score: 1 }, FANOUT_HIGH: { score: 0.94 } },
    {},
  ])('refuses retired or unproven SQL and cached authority', async (sourceBreakdown) => {
    const { prisma, registry, runtimeProfiles } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(
      prisma as never,
      createConfigMock({
        SPAMMER_PROFILE_CACHE_ENABLED: 'true',
        SPAMMER_READ_MODEL_ENFORCEMENT_ENABLED: 'true',
      }),
    );
    const expiresAt = new Date(Date.now() + 60_000);
    registry.set('retired', { userId: 'retired', expiresAt, sourceBreakdown });
    runtimeProfiles.set('retired', {
      userId: 'retired',
      registryStatus: 'ACTIVE_CONFIRMED',
      sourceVersion: 2,
      action: 'DELETE_AND_KICK',
      sourceBreakdown,
      updatedAt: new Date(),
      expiresAt,
      staleAfter: expiresAt,
    });
    await expect(
      service.evaluatePolicy({
        userId: 'retired',
        chatId: 'chat',
        trigger: 'test',
        deleteSpammersEnabled: true,
      }),
    ).resolves.toMatchObject({ action: 'NONE' });
    await service.processObservationDenormJob({
      source: 'DEVELOPER_FORCED',
      userId: 'retired',
      createdAt: new Date().toISOString(),
    });
    expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
  });

  it('keeps an exact duplicate at its original time and records just one detection', async () => {
    const { prisma, observations, registry } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    const event = {
      userId: 'repeat-exact',
      chatId: 'chat',
      messageId: 'm',
      source: 'FANOUT_HIGH' as const,
      reason: 'FANOUT_EPISODE_CONFIRMED',
      score: 0.94,
      forceRegistry: true,
    };
    const first = new Date();
    await service.recordObservation({ ...event, observedAt: first });
    await service.recordObservation({
      ...event,
      observedAt: new Date(first.getTime() + 86400000),
      evidence: { unrelated: 'new content' },
    });
    expect(observations).toHaveLength(1);
    expect(observations[0].observedAt).toEqual(first);
    expect(prisma.globalSpammer.upsert).toHaveBeenCalledTimes(1);
    expect(registry.has(event.userId)).toBe(true);
  });

  it('keeps a strong fanout and its own graph pattern out of the registry', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    for (const userId of ['first', 'second']) {
      const result = await service.recordObservation({
        userId,
        chatId: 'chat',
        source: 'FANOUT_HIGH',
        reason: 'FANOUT_EPISODE_STRONG',
        score: 0.82,
        evidence: { uniqueChats: 6, windowSec: 120 },
      });
      expect(result.outcome).not.toBe('registry');
    }
    expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
  });

  it('keeps medium-confidence fanout in review instead of the registry', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    const result = await service.recordObservation({
      userId: 'User-1',
      source: 'FANOUT_REPEAT',
      score: 0.68,
      reason: 'HIGH_FANOUT_5_CHATS_REPEAT',
      chatId: 'chat-1',
      evidence: { uniqueChats: 5 },
    });

    expect(result.outcome).toBe('candidate');
    expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
    expect(prisma.globalSpammerCandidate.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userId: 'user-1',
          status: 'PENDING',
          confidenceScore: expect.any(Number),
        }),
      }),
    );
  });

  it('does not enqueue observation denorm work while the queue flag is disabled', async () => {
    const { prisma } = createPrismaMock();
    const queue = {
      add: jest.fn(),
    };
    const service = new GlobalSpammerIntelligenceService(
      prisma as never,
      createConfigMock({ SPAMMER_OBSERVATION_DENORM_QUEUE_ENABLED: 'false' }),
      undefined,
      undefined,
      queue as never,
    );

    await service.recordObservation({
      userId: 'user-denorm-off',
      source: 'FANOUT_REPEAT',
      score: 0.68,
      reason: 'HIGH_FANOUT_5_CHATS_REPEAT',
      chatId: 'chat-1',
      evidence: { uniqueChats: 5 },
    });

    expect(queue.add).not.toHaveBeenCalled();
    expect(prisma.globalSpammerCandidate.upsert).toHaveBeenCalled();
  });

  it('enqueues observation denorm jobs with per-user latest-state deduplication', async () => {
    const { prisma } = createPrismaMock();
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
    };
    const service = new GlobalSpammerIntelligenceService(
      prisma as never,
      createConfigMock({ SPAMMER_OBSERVATION_DENORM_QUEUE_ENABLED: 'true' }),
      undefined,
      undefined,
      queue as never,
    );

    await service.recordObservation({
      userId: 'User-Denorm-1',
      source: 'FANOUT_REPEAT',
      score: 0.68,
      reason: 'HIGH_FANOUT_5_CHATS_REPEAT',
      chatId: 'chat-1',
      evidenceHash: 'denorm-1',
      evidence: { uniqueChats: 5 },
    });
    await service.recordObservation({
      userId: 'User-Denorm-1',
      source: 'FANOUT_REPEAT',
      score: 0.7,
      reason: 'HIGH_FANOUT_5_CHATS_REPEAT',
      chatId: 'chat-2',
      evidenceHash: 'denorm-2',
      evidence: { uniqueChats: 6 },
    });

    const deduplicationId = buildGlobalSpammerDenormDeduplicationId('user-denorm-1');
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenCalledWith(
      GLOBAL_SPAMMER_DENORM_JOB_NAME,
      expect.objectContaining({
        userId: 'user-denorm-1',
        chatId: 'chat-1',
        observationId: expect.any(String),
        source: 'FANOUT_REPEAT',
      }),
      expect.objectContaining({
        deduplication: {
          id: deduplicationId,
          keepLastIfActive: true,
        },
      }),
    );
    expect(queue.add).toHaveBeenLastCalledWith(
      GLOBAL_SPAMMER_DENORM_JOB_NAME,
      expect.objectContaining({
        userId: 'user-denorm-1',
        chatId: 'chat-2',
        observationId: expect.any(String),
        source: 'FANOUT_REPEAT',
      }),
      expect.objectContaining({
        deduplication: {
          id: deduplicationId,
          keepLastIfActive: true,
        },
      }),
    );
  });

  it('uses fast observation ledger writes without immediate denorm when explicitly enabled', async () => {
    const { observations, prisma } = createPrismaMock();
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
    };
    const service = new GlobalSpammerIntelligenceService(
      prisma as never,
      createConfigMock({
        SPAMMER_OBSERVATION_DENORM_QUEUE_ENABLED: 'true',
        SPAMMER_OBSERVATION_FAST_PATH_ENABLED: 'true',
      }),
      undefined,
      undefined,
      queue as never,
    );

    const result = await service.recordObservation({
      userId: 'User-Fast-Path',
      source: 'FANOUT_REPEAT',
      score: 0.68,
      reason: 'HIGH_FANOUT_5_CHATS_REPEAT',
      chatId: 'chat-1',
      evidenceHash: 'fast-path-1',
      evidence: { uniqueChats: 5 },
    });

    expect(result).toEqual(
      expect.objectContaining({
        outcome: 'observed',
        userId: 'user-fast-path',
        aggregateScore: 0.68,
      }),
    );
    expect(observations).toEqual([
      expect.objectContaining({
        userId: 'user-fast-path',
        source: 'FANOUT_REPEAT',
        evidenceHash: 'fast-path-1',
      }),
    ]);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(prisma.globalSpammerCandidate.upsert).not.toHaveBeenCalled();
    expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
    expect(prisma.spammerCampaignCluster.upsert).not.toHaveBeenCalled();
    expect(prisma.globalSpammerShadowScore.create).not.toHaveBeenCalled();
  });

  it('limits fast observation ledger writes to configured sources', async () => {
    const { prisma } = createPrismaMock();
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
    };
    const service = new GlobalSpammerIntelligenceService(
      prisma as never,
      createConfigMock({
        SPAMMER_OBSERVATION_DENORM_QUEUE_ENABLED: 'true',
        SPAMMER_OBSERVATION_FAST_PATH_ENABLED: 'true',
        SPAMMER_OBSERVATION_FAST_PATH_SOURCES: 'COMMERCIAL_AD,REPEATED_LINK',
      }),
      undefined,
      undefined,
      queue as never,
    );

    const commercialResult = await service.recordObservation({
      userId: 'User-Fast-Allowlist',
      source: 'COMMERCIAL_AD',
      score: 0.68,
      reason: 'COMMERCIAL_AD_DETECTED',
      chatId: 'chat-1',
      evidenceHash: 'fast-allowlist-1',
      evidence: { excerpt: 'promo' },
    });

    expect(commercialResult.outcome).toBe('observed');
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(prisma.globalSpammerCandidate.upsert).not.toHaveBeenCalled();

    const fanoutResult = await service.recordObservation({
      userId: 'User-Fast-Allowlist',
      source: 'FANOUT_REPEAT',
      score: 0.68,
      reason: 'HIGH_FANOUT_5_CHATS_REPEAT',
      chatId: 'chat-1',
      evidenceHash: 'fast-allowlist-2',
      evidence: { uniqueChats: 5 },
    });

    expect(fanoutResult.outcome).toBe('candidate');
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(prisma.globalSpammerCandidate.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userId: 'user-fast-allowlist',
          status: 'PENDING',
        }),
      }),
    );
  });

  it('fails closed for invalid fast observation source configuration', async () => {
    const { prisma } = createPrismaMock();
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
    };
    const service = new GlobalSpammerIntelligenceService(
      prisma as never,
      createConfigMock({
        SPAMMER_OBSERVATION_DENORM_QUEUE_ENABLED: 'true',
        SPAMMER_OBSERVATION_FAST_PATH_ENABLED: 'true',
        SPAMMER_OBSERVATION_FAST_PATH_SOURCES: 'NOT_A_SOURCE',
      }),
      undefined,
      undefined,
      queue as never,
    );

    const result = await service.recordObservation({
      userId: 'User-Fast-Invalid-Config',
      source: 'COMMERCIAL_AD',
      score: 0.68,
      reason: 'COMMERCIAL_AD_DETECTED',
      chatId: 'chat-1',
      evidenceHash: 'fast-invalid-config-1',
      evidence: { excerpt: 'promo' },
    });

    expect(result.outcome).toBe('observed');
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      GLOBAL_SPAMMER_DENORM_JOB_NAME,
      expect.not.objectContaining({
        fastPath: true,
      }),
      expect.any(Object),
    );
    expect(prisma.globalSpammerShadowScore.create).toHaveBeenCalled();
  });

  it('falls back to synchronous denorm when fast-path enqueue fails', async () => {
    const { prisma } = createPrismaMock();
    const queue = {
      add: jest.fn().mockRejectedValue(new Error('redis down')),
    };
    const service = new GlobalSpammerIntelligenceService(
      prisma as never,
      createConfigMock({
        SPAMMER_OBSERVATION_DENORM_QUEUE_ENABLED: 'true',
        SPAMMER_OBSERVATION_FAST_PATH_ENABLED: 'true',
      }),
      undefined,
      undefined,
      queue as never,
    );

    const result = await service.recordObservation({
      userId: 'User-Fast-Fallback',
      source: 'FANOUT_REPEAT',
      score: 0.68,
      reason: 'HIGH_FANOUT_5_CHATS_REPEAT',
      chatId: 'chat-1',
      evidenceHash: 'fast-fallback-1',
      evidence: { uniqueChats: 5 },
    });

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('candidate');
    expect(prisma.globalSpammerCandidate.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userId: 'user-fast-fallback',
          status: 'PENDING',
        }),
      }),
    );
  });

  it('keeps manual/admin observation sources synchronous even during active suppression', async () => {
    const { prisma } = createPrismaMock();
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
    };
    const service = new GlobalSpammerIntelligenceService(
      prisma as never,
      createConfigMock({
        SPAMMER_OBSERVATION_DENORM_QUEUE_ENABLED: 'true',
        SPAMMER_OBSERVATION_FAST_PATH_ENABLED: 'true',
      }),
      undefined,
      undefined,
      queue as never,
    );
    await service.recordSuppression({
      userId: 'User-Manual-Sync',
      source: 'MANUAL_UNBAN',
      reason: 'false positive',
      adminUserId: 'admin-1',
    });
    jest.clearAllMocks();

    const result = await service.recordManualBanObservation({
      chatId: 'chat-1',
      targetUserId: 'User-Manual-Sync',
      actorUserId: 'admin-2',
      source: 'miniapp',
      executionMode: 'ban',
    });

    expect(result.outcome).toBe('suppressed');
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(prisma.globalSpammerCandidate.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userId: 'user-manual-sync',
          status: 'SUPPRESSED',
          falsePositive: true,
        }),
      }),
    );
  });

  it('replays fast-path observation denorm jobs idempotently from the ledger', async () => {
    const {
      campaignClusters,
      campaignMembers,
      candidateChats,
      candidates,
      prisma,
      shadowScores,
      observations,
    } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(
      prisma as never,
      createConfigMock({
        SPAMMER_PROFILE_CACHE_ENABLED: 'true',
        SPAMMER_OBSERVATION_DENORM_QUEUE_ENABLED: 'true',
        SPAMMER_OBSERVATION_FAST_PATH_ENABLED: 'true',
      }),
      undefined,
      undefined,
      { add: jest.fn().mockResolvedValue(undefined) } as never,
    );
    const observedAt = new Date(Date.now() - 1_000);

    await service.recordObservation({
      userId: 'User-Denorm-Idempotent',
      source: 'FANOUT_REPEAT',
      score: 0.68,
      reason: 'HIGH_FANOUT_5_CHATS_REPEAT',
      chatId: 'chat-1',
      messageId: 'message-1',
      userLabel: 'Быстрый Автор',
      evidenceHash: 'denorm-idempotent-1',
      evidence: {
        uniqueChats: 5,
        windowSec: 120,
        excerpt: 'Промо https://replay.example/order общий текст кампании сегодня',
      },
      observedAt,
    });
    expect(prisma.globalSpammerCandidate.upsert).not.toHaveBeenCalled();
    prisma.globalSpammerCandidate.upsert.mockClear();
    prisma.globalSpammerCandidateChat.upsert.mockClear();
    prisma.spammerCampaignCluster.upsert.mockClear();
    prisma.spammerCampaignClusterMember.upsert.mockClear();
    prisma.globalSpammerShadowScore.create.mockClear();

    const job = {
      userId: 'User-Denorm-Idempotent',
      chatId: 'chat-1',
      observationId: observations[0].id,
      source: 'FANOUT_REPEAT',
      reason: 'HIGH_FANOUT_5_CHATS_REPEAT',
      userLabel: 'Быстрый Автор',
      observedAt: observedAt.toISOString(),
      fastPath: true,
      createdAt: new Date().toISOString(),
    };

    await service.processObservationDenormJob(job);
    const firstCandidate = candidates.get('user-denorm-idempotent');
    const firstEdge = candidateChats.get('user-denorm-idempotent:chat-1');
    const firstCluster = campaignClusters[0];
    const firstMember = campaignMembers[0];
    await service.processObservationDenormJob(job);

    expect(candidates.get('user-denorm-idempotent')).toEqual(
      expect.objectContaining({
        status: 'PENDING',
        detectionsCount: firstCandidate?.detectionsCount,
        confidenceScore: firstCandidate?.confidenceScore,
        lastUserLabel: 'Быстрый Автор',
      }),
    );
    expect(candidateChats.get('user-denorm-idempotent:chat-1')).toEqual(
      expect.objectContaining({
        detectionsCount: firstEdge?.detectionsCount,
        lastMessageId: 'message-1',
        lastUserLabel: 'Быстрый Автор',
      }),
    );
    expect(campaignClusters[0]).toEqual(
      expect.objectContaining({
        id: firstCluster?.id,
        observationsCount: firstCluster?.observationsCount,
      }),
    );
    expect(campaignMembers[0]).toEqual(
      expect.objectContaining({
        clusterId: firstMember?.clusterId,
        observationsCount: firstMember?.observationsCount,
      }),
    );
    expect(shadowScores).toHaveLength(1);
    expect(shadowScores[0]).toEqual(
      expect.objectContaining({
        userId: 'user-denorm-idempotent',
        observationId: observations[0].id,
        campaignBreakdown: expect.any(Object),
      }),
    );
    const updateCalls = prisma.globalSpammerCandidate.upsert.mock.calls.map(
      (call) => call[0]?.update,
    );
    for (const update of updateCalls) {
      expect(update?.detectionsCount).not.toEqual(
        expect.objectContaining({ increment: expect.any(Number) }),
      );
    }
  });

  it('leaves queued observation denorm jobs as runtime-profile refresh only while fast path is off', async () => {
    const { candidates, prisma, runtimeProfiles } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(
      prisma as never,
      createConfigMock({ SPAMMER_PROFILE_CACHE_ENABLED: 'true' }),
    );

    await service.recordObservation({
      userId: 'User-Denorm-Flag-Off',
      source: 'FANOUT_REPEAT',
      score: 0.68,
      reason: 'HIGH_FANOUT_5_CHATS_REPEAT',
      chatId: 'chat-1',
      evidenceHash: 'denorm-flag-off-1',
      evidence: { uniqueChats: 5 },
    });
    candidates.clear();
    prisma.globalSpammerCandidate.upsert.mockClear();

    await service.processObservationDenormJob({
      userId: 'User-Denorm-Flag-Off',
      chatId: 'chat-1',
      observationId: 'obs-1',
      source: 'FANOUT_REPEAT',
      reason: 'HIGH_FANOUT_5_CHATS_REPEAT',
      observedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    expect(prisma.globalSpammerCandidate.upsert).not.toHaveBeenCalled();
    expect(runtimeProfiles.get('user-denorm-flag-off')).toEqual(
      expect.objectContaining({
        registryStatus: 'NONE',
      }),
    );
  });

  it('refreshes the runtime profile read model from observation denorm jobs', async () => {
    const { prisma, runtimeProfiles } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    prisma.globalSpammer.findUnique.mockResolvedValueOnce({
      userId: 'user-denorm-profile',
      confidenceScore: 0.92,
      lastReason: 'REVIEW_APPROVED',
      expiresAt: new Date(Date.now() + 60_000),
      sourceBreakdown: { REVIEW_APPROVED: { score: 1 } },
    });

    await service.processObservationDenormJob({
      userId: 'User-Denorm-Profile',
      chatId: 'chat-1',
      observationId: 'obs-profile',
      source: 'REVIEW_APPROVED',
      reason: 'REVIEW_APPROVED',
      observedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    expect(prisma.globalSpammerRuntimeProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-denorm-profile' },
        create: expect.objectContaining({
          registryStatus: 'ACTIVE_CONFIRMED',
          action: 'DELETE_AND_KICK',
          confidenceScore: 0.92,
          reason: 'REVIEW_APPROVED',
          sourceVersion: 3,
        }),
      }),
    );
    expect(runtimeProfiles.get('user-denorm-profile')).toEqual(
      expect.objectContaining({
        registryStatus: 'ACTIVE_CONFIRMED',
        action: 'DELETE_AND_KICK',
        reason: 'REVIEW_APPROVED',
      }),
    );
    expect(prisma.globalSpammerEnforcementDecision.create).not.toHaveBeenCalled();
  });

  it('keeps denorm runtime profile refresh off campaign fallback queries', async () => {
    const { prisma, runtimeProfiles, shadowScores } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    shadowScores.push({
      id: 'shadow-denorm-light',
      userId: 'user-denorm-light',
      chatId: 'chat-1',
      messageId: null,
      observationId: 'obs-denorm-light',
      trigger: 'test',
      currentScore: 0.5,
      v2Score: 0.81,
      scoreDelta: 0.31,
      currentBand: 'MEDIUM',
      v2Band: 'HIGH',
      wouldPromote: true,
      wouldSuppress: false,
      humanReviewOutcome: null,
      reviewedAt: null,
      reviewedByUserId: null,
      sourceBreakdown: {},
      campaignBreakdown: {},
      createdAt: new Date(),
    });
    prisma.globalSpammer.findUnique.mockResolvedValueOnce({
      userId: 'user-denorm-light',
      confidenceScore: 0.91,
      lastReason: 'REVIEW_APPROVED',
      expiresAt: new Date(Date.now() + 60_000),
      sourceBreakdown: { REVIEW_APPROVED: { score: 1 } },
    });

    await service.processObservationDenormJob({
      userId: 'User-Denorm-Light',
      chatId: 'chat-1',
      observationId: 'obs-denorm-light',
      source: 'REVIEW_APPROVED',
      reason: 'REVIEW_APPROVED',
      observedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    expect(prisma.spammerCampaignClusterMember.findMany).not.toHaveBeenCalled();
    expect(prisma.globalSpammerRuntimeProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          campaignBreakdown: expect.any(Object),
        }),
      }),
    );
    expect(runtimeProfiles.get('user-denorm-light')).toEqual(
      expect.objectContaining({
        registryStatus: 'ACTIVE_CONFIRMED',
        shadowScore: 0.81,
      }),
    );
  });

  it('normalizes legacy confidence levels when listing the review queue', async () => {
    const { observations, prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    const observedAt = new Date('2026-05-29T12:00:00.000Z');

    observations.push({
      id: 'obs-dirty-confidence',
      userId: 'user-dirty-confidence',
      source: 'FANOUT_REPEAT',
      score: 0.68,
      confidenceLevel: 'MEDIUM_REVIEW',
      reason: 'HIGH_FANOUT_5_CHATS_REPEAT',
      chatId: 'chat-1',
      messageId: null,
      evidenceHash: 'dirty-confidence-hash',
      evidence: null,
      observedAt,
      expiresAt: new Date('2026-06-12T12:00:00.000Z'),
      suppressedAt: null,
      suppressionReason: null,
    });
    prisma.$queryRaw
      .mockResolvedValueOnce([{ userId: 'user-dirty-confidence' }])
      .mockResolvedValueOnce([
        {
          id: 'obs-dirty-confidence',
          userId: 'user-dirty-confidence',
          source: 'FANOUT_REPEAT',
          score: 0.68,
          confidenceLevel: 'MEDIUM_REVIEW',
          reason: 'HIGH_FANOUT_5_CHATS_REPEAT',
          chatId: 'chat-1',
          messageId: null,
          evidenceHash: 'dirty-confidence-hash',
          evidence: null,
          observedAt,
          expiresAt: new Date('2026-06-12T12:00:00.000Z'),
          suppressedAt: null,
          suppressionReason: null,
        },
      ]);
    prisma.globalSpammerCandidate.findMany.mockResolvedValueOnce([
      {
        userId: 'user-dirty-confidence',
        status: 'PENDING',
        confidenceScore: 0.68,
        sourceBreakdown: {},
        lastReason: 'HIGH_FANOUT_5_CHATS_REPEAT',
        lastChatId: 'chat-1',
        lastEvidence: null,
        lastUserLabel: null,
        suppressedUntil: null,
        reviewedAt: null,
        reviewedByUserId: null,
        reviewReason: null,
        falsePositive: false,
        chats: [],
      },
    ]);

    const queue = await service.listReviewQueue({
      chatId: 'chat-1',
      status: 'PENDING',
      includeObservations: true,
      includeLocalProfiles: false,
    });

    expect(queue.items[0]?.observations[0]).toEqual(
      expect.objectContaining({
        confidenceLevel: 'MEDIUM',
      }),
    );
  });

  it('ranks legacy last-chat candidates together with edge candidates in the review queue', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    prisma.$queryRaw.mockResolvedValueOnce([{ userId: 'legacy-high' }, { userId: 'edge-low' }]);
    prisma.globalSpammerCandidate.findMany.mockResolvedValueOnce([
      {
        userId: 'edge-low',
        status: 'PENDING',
        confidenceScore: 0.61,
        sourceBreakdown: {},
        lastReason: 'EDGE_LOW',
        lastChatId: 'chat-1',
        lastEvidence: null,
        lastUserLabel: 'Edge Low',
        suppressedUntil: null,
        reviewedAt: null,
        reviewedByUserId: null,
        reviewReason: null,
        falsePositive: false,
        chats: [],
      },
      {
        userId: 'legacy-high',
        status: 'PENDING',
        confidenceScore: 0.95,
        sourceBreakdown: {},
        lastReason: 'LEGACY_HIGH',
        lastChatId: 'chat-1',
        lastEvidence: null,
        lastUserLabel: 'Legacy High',
        suppressedUntil: null,
        reviewedAt: null,
        reviewedByUserId: null,
        reviewReason: null,
        falsePositive: false,
        chats: [],
      },
    ]);

    const queue = await service.listReviewQueue({
      chatId: 'chat-1',
      status: 'PENDING',
      includeObservations: false,
      limit: 2,
    });

    const rawSql = prisma.$queryRaw.mock.calls[0]?.[0] as { strings?: readonly string[] };
    expect(rawSql.strings?.join(' ')).toContain('UNION ALL');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.globalSpammerCandidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: {
            in: ['legacy-high', 'edge-low'],
          },
        },
      }),
    );
    expect(queue.items.map((item) => item.userId)).toEqual(['legacy-high', 'edge-low']);
  });

  it('attaches local review profile names from chat edges and moderation feed rows', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    prisma.$queryRaw.mockResolvedValueOnce([
      {
        user_id: 'feed-user',
        user_display_name: '  Светлана  ',
      },
      {
        user_id: 'id-like-user',
        user_display_name: '987654321',
      },
    ]);

    const profiles = await service.resolveLocalReviewProfiles({
      chatId: 'chat-1',
      userIds: ['edge-user', 'feed-user', 'id-like-user', 'mention-user'],
      candidates: [
        {
          userId: 'edge-user',
          lastUserLabel: 'edge-user',
          chats: [
            {
              chatId: 'chat-1',
              lastUserLabel: 'Алексей',
              lastDetectedAt: new Date('2026-06-21T08:00:00.000Z'),
            },
          ],
        },
        {
          userId: 'id-like-user',
          lastUserLabel: '123456789',
          chats: [],
        },
        {
          userId: 'mention-user',
          lastUserLabel: '[Мария](max://user/mention-user)',
          chats: [],
        },
      ],
    });

    expect(profiles.get('edge-user')).toEqual({
      userId: 'edge-user',
      displayName: 'Алексей',
    });
    expect(profiles.get('feed-user')).toEqual({
      userId: 'feed-user',
      displayName: 'Светлана',
    });
    expect(profiles.has('mention-user')).toBe(false);
    expect(profiles.has('id-like-user')).toBe(false);
    expect(prisma.$queryRaw).toHaveBeenCalledWith(expect.anything());
  });

  it('promotes high-confidence fanout to the registry', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    const result = await service.recordObservation({
      userId: 'user-2',
      source: 'FANOUT_HIGH',
      score: 0.94,
      reason: 'FANOUT_EPISODE_CONFIRMED',
      chatId: 'chat-6',
      evidence: { uniqueChats: 6 },
      forceRegistry: true,
    });

    expect(result.outcome).toBe('registry');
    expect(prisma.globalSpammer.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userId: 'user-2',
          lastReason: 'FANOUT_EPISODE_CONFIRMED',
          confidenceScore: expect.any(Number),
          sourceBreakdown: expect.objectContaining({
            FANOUT_HIGH: expect.any(Object),
          }),
        }),
      }),
    );
  });

  it('keeps first high-fanout bursts out of the registry until confirmed', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    const result = await service.recordObservation({
      userId: 'user-first-fanout',
      source: 'FANOUT_HIGH',
      score: 0.94,
      reason: 'HIGH_FANOUT_6_CHATS_2M',
      chatId: 'chat-6',
      evidence: { uniqueChats: 6 },
    });

    expect(result.outcome).toBe('candidate');
    expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
    expect(prisma.globalSpammerCandidate.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userId: 'user-first-fanout',
          status: 'PENDING',
        }),
      }),
    );
  });

  it('stores risk-ledger metadata and prunes raw evidence after retention', async () => {
    const { observations, prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    const observedAt = new Date('2026-05-29T12:00:00.000Z');

    await service.recordObservation({
      userId: 'user-ledger',
      source: 'COMMERCIAL_AD',
      score: 0.74,
      reason: 'COMMERCIAL_AD_DETECTED',
      chatId: 'chat-ledger',
      observedAt,
      evidence: {
        excerpt:
          'Продам рекламный доступ сегодня: https://Bad.Example/order?utm=spam +7 (999) 123-45-67',
        mediaFileId: 'photo-cdn-123456789',
      },
    });

    expect(observations).toContainEqual(
      expect.objectContaining({
        userId: 'user-ledger',
        normalizedFeatures: expect.objectContaining({
          source: 'COMMERCIAL_AD',
          ttlDays: 10,
          domains: expect.arrayContaining(['bad.example']),
          urlHashes: expect.arrayContaining([expect.any(String)]),
          phoneHashes: expect.arrayContaining([expect.any(String)]),
          mediaSignatures: expect.arrayContaining([expect.any(String)]),
        }),
        ttlDays: 10,
        explainReason: expect.stringContaining('COMMERCIAL_AD'),
        privacyClass: 'HIGH_SENSITIVITY',
        rawEvidenceExpiresAt: expect.any(Date),
      }),
    );

    await expect(
      service.pruneExpiredRawEvidence({
        now: new Date('2026-06-20T12:00:00.000Z'),
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        scanned: 1,
        pruned: 1,
      }),
    );

    expect(prisma.spammerObservation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          privacyClass: 'MINIMIZED',
          rawEvidenceExpiresAt: null,
          evidence: expect.objectContaining({
            rawEvidencePruned: true,
            domains: expect.arrayContaining(['bad.example']),
            phoneHashes: expect.arrayContaining([expect.any(String)]),
          }),
        }),
      }),
    );
    expect(observations[0]).toEqual(
      expect.objectContaining({
        privacyClass: 'MINIMIZED',
        rawEvidenceExpiresAt: null,
        evidence: expect.objectContaining({
          rawEvidencePruned: true,
        }),
      }),
    );
  });

  it('sanitizes legacy non-finite JSON numbers while pruning raw evidence', async () => {
    const { observations } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService({
      spammerObservation: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'obs-legacy-json',
            evidence: { text: 'legacy text with odd numbers' },
            normalizedFeatures: {
              evidenceHash: 'legacy-hash',
              domains: ['example.com', Number.NaN, undefined, Number.POSITIVE_INFINITY],
              urls: [Number.NEGATIVE_INFINITY, 'https://example.com'],
              phoneHashes: [undefined, 'phone-hash'],
              mediaSignatures: [Number.NaN, 'media-hash'],
              fanout: {
                uniqueChats: Number.POSITIVE_INFINITY,
                duplicateCount: 2,
              },
            },
          },
        ]),
        updateMany: jest.fn(async ({ where, data }: any) => {
          observations.push({ id: where.id, ...data });
          return { count: 1 };
        }),
      },
      $transaction: jest.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
    } as never);

    await expect(
      service.pruneExpiredRawEvidence({
        now: new Date('2026-06-20T12:00:00.000Z'),
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        scanned: 1,
        pruned: 1,
      }),
    );

    expect(observations[0].evidence).toEqual(
      expect.objectContaining({
        evidenceHash: 'legacy-hash',
        domains: ['example.com'],
        urlHashes: [expect.any(String)],
        phoneHashes: ['phone-hash'],
        mediaSignatures: ['media-hash'],
        fanout: {
          uniqueChats: null,
          duplicateCount: 2,
        },
      }),
    );
  });

  it('removes raw excerpts from both evidence and normalized features after retention', async () => {
    const { observations } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService({
      spammerObservation: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'obs-emoji-json',
            evidence: {
              excerpt: `x${'😎'.repeat(140)}`,
            },
            normalizedFeatures: {
              evidenceHash: 'emoji-hash',
            },
          },
        ]),
        updateMany: jest.fn(async ({ where, data }: any) => {
          observations.push({ id: where.id, ...data });
          return { count: 1 };
        }),
      },
      $transaction: jest.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
    } as never);

    await expect(
      service.pruneExpiredRawEvidence({
        now: new Date('2026-06-20T12:00:00.000Z'),
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        scanned: 1,
        pruned: 1,
      }),
    );

    expect(observations[0].evidence).not.toHaveProperty('excerpt');
    expect(JSON.stringify(observations[0])).not.toContain('😎');
  });

  it('continues pruning raw evidence rows individually after a batch failure', async () => {
    const prunedRows: any[] = [];
    let batchMode = true;
    const updateMany = jest.fn(async ({ where, data }: any) => {
      if (batchMode) {
        return { count: 1 };
      }
      if (where.id === 'obs-bad-json') {
        throw new Error('invalid input syntax for type json');
      }
      prunedRows.push({ id: where.id, ...data });
      return { count: 1 };
    });
    const service = new GlobalSpammerIntelligenceService({
      spammerObservation: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'obs-good-json',
            evidence: { text: 'legacy text' },
            normalizedFeatures: {
              evidenceHash: 'good-hash',
              domains: ['example.com'],
            },
          },
          {
            id: 'obs-bad-json',
            evidence: { text: 'legacy text' },
            normalizedFeatures: {
              evidenceHash: 'bad-hash',
            },
          },
        ]),
        updateMany,
      },
      $transaction: jest.fn(async () => {
        batchMode = false;
        throw new Error('invalid input syntax for type json');
      }),
    } as never);

    await expect(
      service.pruneExpiredRawEvidence({
        now: new Date('2026-06-20T12:00:00.000Z'),
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        scanned: 2,
        pruned: 1,
        failed: 1,
        failedIds: ['obs-bad-json'],
      }),
    );

    expect(updateMany).toHaveBeenCalledTimes(4);
    expect(prunedRows).toEqual([
      expect.objectContaining({
        id: 'obs-good-json',
        privacyClass: 'MINIMIZED',
        rawEvidenceExpiresAt: null,
        evidence: expect.objectContaining({
          rawEvidencePruned: true,
          evidenceHash: 'good-hash',
        }),
      }),
    ]);
  });

  it('stores user labels on commercial review candidates', async () => {
    const { candidateChats, candidates, prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    const decisions = await service.recordCommercialObservations({
      chatId: 'chat-1',
      userId: 'commercial-user',
      messageId: 'message-1',
      text: 'Промо https://shop.example/order общий текст кампании',
      userLabel: 'Коммерческий Автор',
      topViolation: {
        ruleCode: 'COMMERCIAL_AD',
        score: 0.95,
        reason: 'commercial',
        metadata: {
          confidenceScore: 95,
          actionBand: 'DELETE_AND_ESCALATE',
          campaignContext: {
            repeatedLinkDistinctChatCount: 2,
            repeatedPhoneDistinctChatCount: 0,
          },
        },
      },
      commercialCampaignContext: null,
    });

    expect(decisions.some((decision) => decision.outcome === 'candidate')).toBe(true);
    expect(candidates.get('commercial-user')).toEqual(
      expect.objectContaining({
        lastUserLabel: 'Коммерческий Автор',
      }),
    );
    expect(candidateChats.get('commercial-user:chat-1')).toEqual(
      expect.objectContaining({
        lastUserLabel: 'Коммерческий Автор',
      }),
    );
  });

  it('combines behavior and reputation signals without over-promoting the aggregate', () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    const now = new Date('2026-05-29T12:00:00.000Z');

    const aggregate = service.computeAggregate(
      [
        {
          id: '1',
          userId: 'user-3',
          source: 'COMMERCIAL_CAMPAIGN',
          score: 0.76,
          reason: 'COMMERCIAL_AD_DETECTED',
          chatId: 'chat-1',
          messageId: 'm1',
          evidenceHash: 'a',
          evidence: null,
          observedAt: now,
          expiresAt: new Date(now.getTime() + 10_000),
        },
        {
          id: '2',
          userId: 'user-3',
          source: 'SANCTION_BAN',
          score: 0.74,
          reason: 'SANCTION_BAN',
          chatId: 'chat-1',
          messageId: 'm1',
          evidenceHash: 'b',
          evidence: null,
          observedAt: now,
          expiresAt: new Date(now.getTime() + 10_000),
        },
        {
          id: '3',
          userId: 'user-3',
          source: 'REPEATED_PHONE',
          score: 0.6,
          reason: 'REPEATED_PHONE_CROSS_CHAT',
          chatId: 'chat-2',
          messageId: 'm2',
          evidenceHash: 'c',
          evidence: null,
          observedAt: now,
          expiresAt: new Date(now.getTime() + 10_000),
        },
      ],
      now,
    );

    expect(aggregate.confidenceLevel).toBe('MEDIUM');
    expect(aggregate.score).toBeGreaterThanOrEqual(0.62);
    expect(aggregate.score).toBeLessThan(0.7);
    expect(aggregate.sourceBreakdown).toEqual(
      expect.objectContaining({
        SANCTION_BAN: expect.objectContaining({
          effect: 'risk',
          score: expect.any(Number),
        }),
      }),
    );
  });

  it('caps reputation-only bans below global registry promotion', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    for (let index = 1; index <= 6; index += 1) {
      await service.recordObservation({
        userId: 'user-reputation-only',
        source: 'MANUAL_BAN',
        score: 1,
        reason: 'MANUAL_BAN',
        chatId: `chat-${index}`,
        evidenceHash: `manual-ban-${index}`,
        evidence: {
          actorUserId: `admin-${index}`,
        },
      });
    }

    expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
    expect(prisma.globalSpammerCandidate.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: 'AUTO_APPROVED',
        }),
      }),
    );

    const diagnostics = await service.getUserDiagnostics({
      chatId: 'chat-1',
      userId: 'user-reputation-only',
      deleteSpammersEnabled: true,
    });
    expect(diagnostics.policy.registryStatus).not.toBe('ACTIVE_CONFIRMED');
    expect(diagnostics.reputationSummary).toEqual(
      expect.objectContaining({
        naturalBanSignals: 6,
        onlyReputationSignals: true,
      }),
    );
  });

  it('treats local admin allow as a mitigating local decision', async () => {
    const { chatAdminAllowlistRows, localAdminDecisions, prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    chatAdminAllowlistRows.push({ chatId: 'chat-local', userId: 'admin-allow' });
    await service.recordLocalAdminDecision({
      chatId: 'chat-local',
      userId: 'user-local-allow',
      reviewerUserId: 'admin-allow',
      decision: 'ALLOW',
      reason: 'MANUAL_UNBAN',
    });

    expect(localAdminDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adminUserId: 'admin-allow',
          userId: 'user-local-allow',
          sourceChatId: 'chat-local',
          decision: 'ALLOW',
          reason: 'MANUAL_UNBAN',
        }),
      ]),
    );

    const diagnostics = await service.getUserDiagnostics({
      chatId: 'chat-local',
      userId: 'user-local-allow',
      deleteSpammersEnabled: true,
    });
    expect(diagnostics.policy).toEqual(
      expect.objectContaining({
        registryStatus: 'ADMIN_EXEMPT',
        action: 'NONE',
        adminExempt: true,
      }),
    );
    expect(diagnostics.localAdminDecision).toEqual(
      expect.objectContaining({
        decision: 'ALLOW',
        decidedByUserIds: ['admin-allow'],
      }),
    );
    expect(diagnostics.reputationSummary).toEqual(
      expect.objectContaining({
        localAllowSignals: 1,
        onlyReputationSignals: true,
      }),
    );
  });

  it('treats local admin block as local enforcement instead of global registry promotion', async () => {
    const { chatAdminAllowlistRows, localAdminDecisions, prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    chatAdminAllowlistRows.push({ chatId: 'chat-local', userId: 'admin-block' });
    await service.recordLocalAdminDecision({
      chatId: 'chat-local',
      userId: 'user-local-block',
      reviewerUserId: 'admin-block',
      decision: 'BLOCK',
      reason: 'LOCAL_ADMIN_BLOCK',
    });

    expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
    expect(localAdminDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adminUserId: 'admin-block',
          userId: 'user-local-block',
          decision: 'BLOCK',
        }),
      ]),
    );

    const diagnostics = await service.getUserDiagnostics({
      chatId: 'chat-local',
      userId: 'user-local-block',
      deleteSpammersEnabled: true,
    });
    expect(diagnostics.policy).toEqual(
      expect.objectContaining({
        registryStatus: 'LOCAL_BLOCKED',
        action: 'DELETE_AND_KICK',
        wouldEnforce: false,
      }),
    );
    expect(diagnostics.localAdminDecision).toEqual(
      expect.objectContaining({
        decision: 'BLOCK',
        decidedByUserIds: ['admin-block'],
      }),
    );
    expect(diagnostics.reputationSummary).toEqual(
      expect.objectContaining({
        localBlockSignals: 1,
        onlyReputationSignals: true,
      }),
    );
  });

  it('reuses the source reputation rollup across diagnostics and observation writes', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    prisma.$queryRaw.mockResolvedValueOnce([
      {
        source: 'FANOUT_HIGH',
        observedCount: 12n,
        suppressedCount: 0n,
      },
    ]);

    await service.getUserDiagnostics({
      chatId: 'chat-1',
      userId: 'user-cache-1',
    });
    await service.recordObservation({
      userId: 'user-cache-observation',
      source: 'FANOUT_REPEAT',
      score: 0.68,
      reason: 'HIGH_FANOUT_5_CHATS_REPEAT',
      chatId: 'chat-1',
      evidence: { uniqueChats: 5 },
    });
    await service.getUserDiagnostics({
      chatId: 'chat-1',
      userId: 'user-cache-2',
    });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const reputationSql = prisma.$queryRaw.mock.calls[0]?.[0] as { strings?: readonly string[] };
    expect(reputationSql.strings?.join(' ')).toContain('COUNT(*) FILTER');
    expect(prisma.spammerObservation.groupBy).not.toHaveBeenCalled();
  });

  it('uses a narrow observation select for aggregate recomputation', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    await service.recordObservation({
      userId: 'user-aggregate-select',
      source: 'FANOUT_REPEAT',
      score: 0.68,
      reason: 'HIGH_FANOUT_5_CHATS_REPEAT',
      chatId: 'chat-1',
      evidence: { uniqueChats: 5, rawPayload: 'wide-value' },
    });

    const aggregateCalls = prisma.spammerObservation.findMany.mock.calls.filter(
      ([args]) =>
        args?.where?.userId === 'user-aggregate-select' && args?.where?.suppressedAt === null,
    );
    expect(aggregateCalls.length).toBeGreaterThan(0);
    expect(aggregateCalls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        select: {
          source: true,
          score: true,
          reason: true,
          observedAt: true,
          expiresAt: true,
        },
      }),
    );
  });

  it('reuses preloaded registry state while building diagnostics policy', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    await service.getUserDiagnostics({
      chatId: 'chat-1',
      userId: 'user-dossier-cache',
      deleteSpammersEnabled: true,
    });

    expect(prisma.globalSpammer.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.globalSpammerCandidate.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.globalSpammerSuppression.findFirst).toHaveBeenCalledTimes(1);
  });

  it('suppresses active observations after manual unban', async () => {
    const { prisma, observations } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    await service.recordObservation({
      userId: 'user-4',
      source: 'FANOUT_HIGH',
      score: 0.94,
      reason: 'HIGH_FANOUT_6_CHATS_2M',
      chatId: 'chat-1',
    });
    await service.recordSuppression({
      userId: 'user-4',
      source: 'MANUAL_UNBAN',
      reason: 'MANUAL_UNBAN',
      adminUserId: 'admin-1',
      sourceChatId: 'chat-1',
    });

    expect(prisma.globalSpammer.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-4' } });
    expect(observations.every((row) => row.suppressedAt instanceof Date)).toBe(true);
  });

  it('raises source-quality alerts for dominated or suppressed sources', () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    expect(
      service.buildSourceAlerts({
        recentObservations: [
          { source: 'FANOUT_REPEAT', count: 80 },
          { source: 'COMMERCIAL_AD', count: 10 },
        ],
        suppressedObservations: [],
      }),
    ).toContainEqual(
      expect.objectContaining({
        source: 'FANOUT_REPEAT',
        level: 'warning',
      }),
    );

    expect(
      service.buildSourceAlerts({
        recentObservations: [{ source: 'REPEATED_LINK', count: 20 }],
        suppressedObservations: [{ source: 'REPEATED_LINK', count: 9 }],
      }),
    ).toContainEqual(
      expect.objectContaining({
        source: 'REPEATED_LINK',
        reason: expect.stringContaining('suppression rate'),
      }),
    );
  });

  it('reports lightweight review and false-positive metrics by default', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          pending: 4n,
          approved: 7n,
          suppressed: 3n,
          reviewed: 5n,
          falsePositiveCount: 2n,
          newCandidates24h: 6n,
          autoApproved24h: 1n,
          suppressed24h: 2n,
        },
      ])
      .mockResolvedValueOnce([
        {
          source: 'FANOUT_REPEAT',
          observedCount: 12n,
          suppressedCount: 2n,
        },
      ]);

    const metrics = await service.getReviewMetrics({ chatId: 'chat-1' });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.globalSpammer.count).not.toHaveBeenCalled();
    expect(prisma.globalSpammerArchive.count).not.toHaveBeenCalled();
    expect(prisma.globalSpammerShadowScore.count).not.toHaveBeenCalled();
    expect(prisma.spammerCampaignCluster.findMany).not.toHaveBeenCalled();
    expect(prisma.globalSpammerCandidate.count).not.toHaveBeenCalled();
    expect(prisma.spammerObservation.groupBy).not.toHaveBeenCalled();
    expect(metrics).toEqual(
      expect.objectContaining({
        pending: 4,
        approved: 7,
        suppressed: 3,
        reviewed: 5,
        activeRegistry: 0,
        expiredRegistry: 0,
        archivedExpired: 0,
        shadowWouldEnforceCount: 0,
        falsePositiveCount: 2,
        falsePositiveRate: 0.4,
        topCampaigns: [],
        sourceReputation: [],
      }),
    );
  });

  it('reports full review metrics when requested', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          pending: 4n,
          approved: 7n,
          suppressed: 3n,
          reviewed: 5n,
          falsePositiveCount: 2n,
          newCandidates24h: 6n,
          autoApproved24h: 1n,
          suppressed24h: 2n,
        },
      ])
      .mockResolvedValueOnce([
        {
          source: 'FANOUT_REPEAT',
          observedCount: 12n,
          suppressedCount: 2n,
        },
      ])
      .mockResolvedValueOnce([
        {
          activeRegistry: 9n,
          expiredRegistry: 1n,
          archivedExpired: 8n,
          shadowWouldEnforceCount: 3n,
        },
      ])
      .mockResolvedValueOnce([
        {
          source: 'FANOUT_REPEAT',
          observedCount: 12n,
          suppressedCount: 2n,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'cluster-1',
          signalType: 'URL',
          status: 'ACTIVE',
          confidenceScore: 0.83,
          distinctUsersCount: 4,
          distinctChatsCount: 2,
          observationsCount: 9,
          lastSeenAt: new Date('2026-05-29T12:00:00.000Z'),
          signalValuePreview: 'example.test',
        },
      ]);

    const metrics = await service.getReviewMetrics({ chatId: 'chat-1', mode: 'full' });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(5);
    const registrySql = prisma.$queryRaw.mock.calls[2]?.[0] as {
      strings?: readonly string[];
    };
    expect(registrySql.strings?.join(' ')).toContain('global_spammer_archives');
    expect(registrySql.strings?.join(' ')).toContain('global_spammer_shadow_scores');
    const sourceReputationSql = prisma.$queryRaw.mock.calls[3]?.[0] as {
      strings?: readonly string[];
    };
    expect(sourceReputationSql.strings?.join(' ')).toContain('COUNT(*) FILTER');
    const topCampaignsSql = prisma.$queryRaw.mock.calls[4]?.[0] as { strings?: readonly string[] };
    expect(topCampaignsSql.strings?.join(' ')).toContain('spammer_campaign_cluster_members');
    expect(topCampaignsSql.strings?.join(' ')).toContain('member.last_seen_at');
    expect(prisma.globalSpammer.count).not.toHaveBeenCalled();
    expect(prisma.globalSpammerArchive.count).not.toHaveBeenCalled();
    expect(prisma.globalSpammerShadowScore.count).not.toHaveBeenCalled();
    expect(prisma.globalSpammerCandidate.count).not.toHaveBeenCalled();
    expect(prisma.spammerObservation.groupBy).not.toHaveBeenCalled();
    expect(metrics).toEqual(
      expect.objectContaining({
        pending: 4,
        approved: 7,
        suppressed: 3,
        reviewed: 5,
        activeRegistry: 9,
        expiredRegistry: 1,
        archivedExpired: 8,
        shadowWouldEnforceCount: 3,
        falsePositiveCount: 2,
        falsePositiveRate: 0.4,
        topCampaigns: [
          expect.objectContaining({
            clusterId: 'cluster-1',
            confidenceScore: 0.83,
          }),
        ],
      }),
    );
  });

  it('archives expired registry rows before deleting them from the active registry', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    const now = new Date('2026-05-29T12:00:00.000Z');
    const expiredAt = new Date('2026-05-28T12:00:00.000Z');
    prisma.globalSpammer.findMany.mockResolvedValueOnce([
      {
        userId: 'user-expired-1',
        firstDetectedAt: new Date('2026-05-20T12:00:00.000Z'),
        lastDetectedAt: new Date('2026-05-22T12:00:00.000Z'),
        detectionsCount: 3,
        lastReason: 'HIGH_FANOUT_6_CHATS_2M',
        lastChatId: 'chat-1',
        lastEvidence: { uniqueChats: 6 },
        confidenceScore: 0.96,
        confirmedAt: new Date('2026-05-22T12:00:00.000Z'),
        expiresAt: expiredAt,
        sourceBreakdown: { FANOUT_HIGH: { score: 0.96 } },
      },
    ]);
    prisma.globalSpammerArchive.createMany.mockResolvedValueOnce({ count: 1 });
    prisma.globalSpammer.deleteMany.mockResolvedValueOnce({ count: 1 });
    prisma.globalSpammer.count.mockResolvedValueOnce(0);

    await expect(service.archiveExpiredRegistryEntries({ now, limit: 25 })).resolves.toEqual(
      expect.objectContaining({
        dryRun: false,
        scanned: 1,
        archived: 1,
        deleted: 1,
        remainingExpired: 0,
      }),
    );
    expect(prisma.globalSpammerArchive.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            userId: 'user-expired-1',
            expiredAt,
            archiveReason: 'EXPIRED',
          }),
        ],
        skipDuplicates: true,
      }),
    );
    expect(prisma.globalSpammer.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: {
          in: ['user-expired-1'],
        },
        OR: [
          {
            expiresAt: null,
          },
          {
            expiresAt: {
              lte: now,
            },
          },
        ],
      },
    });
  });

  it('archives nullable legacy registry rows as expired', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    const now = new Date('2026-05-29T12:00:00.000Z');
    prisma.globalSpammer.findMany.mockResolvedValueOnce([
      {
        userId: 'user-legacy-null-expiry',
        firstDetectedAt: new Date('2026-05-20T12:00:00.000Z'),
        lastDetectedAt: new Date('2026-05-22T12:00:00.000Z'),
        detectionsCount: 1,
        lastReason: 'legacy row',
        lastChatId: null,
        lastEvidence: null,
        confidenceScore: 1,
        confirmedAt: new Date('2026-05-22T12:00:00.000Z'),
        expiresAt: null,
        sourceBreakdown: {},
      },
    ]);
    prisma.globalSpammerArchive.createMany.mockResolvedValueOnce({ count: 1 });
    prisma.globalSpammer.deleteMany.mockResolvedValueOnce({ count: 1 });
    prisma.globalSpammer.count.mockResolvedValueOnce(0);

    await expect(service.archiveExpiredRegistryEntries({ now })).resolves.toEqual(
      expect.objectContaining({
        scanned: 1,
        archived: 1,
        deleted: 1,
        remainingExpired: 0,
      }),
    );

    expect(prisma.globalSpammer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            {
              expiresAt: null,
            },
            {
              expiresAt: {
                lte: now,
              },
            },
          ],
        },
      }),
    );
    expect(prisma.globalSpammerArchive.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            userId: 'user-legacy-null-expiry',
            expiredAt: null,
          }),
        ],
      }),
    );
  });

  it('down-weights noisy sources with recent false positives', () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    const now = new Date('2026-05-29T12:00:00.000Z');

    const aggregate = service.computeAggregate(
      [
        {
          id: '1',
          userId: 'user-source-noise',
          source: 'FANOUT_HIGH',
          score: 0.94,
          reason: 'HIGH_FANOUT_6_CHATS_2M',
          chatId: 'chat-1',
          messageId: 'm1',
          evidenceHash: 'noise',
          evidence: null,
          observedAt: now,
          expiresAt: new Date(now.getTime() + 10_000),
        },
      ],
      now,
      new Map([
        [
          'FANOUT_HIGH',
          {
            source: 'FANOUT_HIGH',
            weight: 0.5,
            falsePositiveRate: 0.7,
            observations: 20,
            suppressed: 14,
          },
        ],
      ]) as never,
    );

    expect(aggregate.score).toBeLessThan(0.55);
    expect(aggregate.sourceBreakdown).toEqual(
      expect.objectContaining({
        FANOUT_HIGH: expect.objectContaining({
          reputationWeight: 0.5,
          falsePositiveRate: 0.7,
        }),
      }),
    );
  });

  it('applies source weights before false-positive penalties', () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    const now = new Date('2026-05-29T12:00:00.000Z');

    const aggregate = service.computeAggregate(
      [
        {
          id: '1',
          userId: 'user-source-weight',
          source: 'COMMERCIAL_AD',
          score: 1,
          reason: 'COMMERCIAL_AD_DETECTED',
          chatId: 'chat-1',
          messageId: 'm1',
          evidenceHash: 'weight',
          evidence: null,
          observedAt: now,
          expiresAt: new Date(now.getTime() + 10_000),
        },
      ],
      now,
    );

    expect(aggregate.score).toBe(0.45);
    expect(aggregate.sourceBreakdown).toEqual(
      expect.objectContaining({
        COMMERCIAL_AD: expect.objectContaining({
          reputationWeight: 0.45,
          falsePositiveRate: 0,
        }),
      }),
    );
  });

  it('turns repeated graph signals into separate observations', async () => {
    const { prisma, observations, spammerGraphSignalRows } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    await service.recordObservation({
      userId: 'user-graph-1',
      source: 'COMMERCIAL_AD',
      score: 0.58,
      reason: 'COMMERCIAL_AD_DETECTED',
      chatId: 'chat-1',
      evidence: { excerpt: 'Реклама услуги на https://bad.example/order сегодня' },
    });
    await service.recordObservation({
      userId: 'user-graph-2',
      source: 'COMMERCIAL_AD',
      score: 0.58,
      reason: 'COMMERCIAL_AD_DETECTED',
      chatId: 'chat-2',
      evidence: { excerpt: 'Реклама услуги на https://bad.example/order сегодня' },
    });

    expect(spammerGraphSignalRows).toHaveLength(4);
    expect(
      observations.find((row) => row.userId === 'user-graph-2' && row.source === 'GRAPH_DOMAIN'),
    ).toEqual(
      expect.objectContaining({
        normalizedFeatures: expect.objectContaining({
          domains: expect.arrayContaining(['bad.example']),
        }),
        explainReason: expect.stringContaining('GRAPH_DOMAIN'),
        privacyClass: 'STANDARD',
      }),
    );
  });

  it('links campaign clusters into shadow scoring and diagnostics', async () => {
    const { campaignClusters, campaignMembers, prisma, shadowScores } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    await service.recordObservation({
      userId: 'user-campaign-1',
      source: 'COMMERCIAL_AD',
      score: 0.72,
      reason: 'COMMERCIAL_AD_DETECTED',
      chatId: 'chat-1',
      evidence: { excerpt: 'Промо https://network.example/order общий текст кампании сегодня' },
    });
    await service.recordObservation({
      userId: 'user-campaign-2',
      source: 'COMMERCIAL_AD',
      score: 0.72,
      reason: 'COMMERCIAL_AD_DETECTED',
      chatId: 'chat-2',
      evidence: { excerpt: 'Промо https://network.example/order общий текст кампании сегодня' },
    });

    expect(campaignClusters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'ACTIVE',
          distinctUsersCount: 2,
          distinctChatsCount: 2,
        }),
      ]),
    );
    expect(campaignMembers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: 'user-campaign-1' }),
        expect.objectContaining({ userId: 'user-campaign-2' }),
      ]),
    );
    const latestShadowScore = shadowScores.at(-1);
    expect(latestShadowScore).toEqual(
      expect.objectContaining({
        userId: 'user-campaign-2',
        currentScore: expect.any(Number),
        v2Score: expect.any(Number),
        campaignBreakdown: expect.any(Object),
      }),
    );
    expect(latestShadowScore.v2Score).toBeGreaterThan(latestShadowScore.currentScore);

    await expect(
      service.getUserDiagnostics({
        chatId: 'chat-2',
        userId: 'user-campaign-2',
        deleteSpammersEnabled: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        campaigns: expect.arrayContaining([
          expect.objectContaining({
            distinctUsersCount: 2,
            observationsCount: 2,
            userObservationsCount: 1,
          }),
        ]),
        latestShadowScore: expect.objectContaining({
          v2Score: latestShadowScore.v2Score,
        }),
        policy: expect.objectContaining({
          shadowScore: latestShadowScore.v2Score,
          campaignBreakdown: expect.any(Object),
        }),
      }),
    );
  });

  it('suppresses graph observations created during an active suppression window', async () => {
    const { prisma, observations } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    await service.recordObservation({
      userId: 'user-graph-seed',
      source: 'COMMERCIAL_AD',
      score: 0.58,
      reason: 'COMMERCIAL_AD_DETECTED',
      chatId: 'chat-1',
      evidence: { excerpt: 'Реклама услуги на https://bad.example/order сегодня' },
    });
    await service.recordSuppression({
      userId: 'user-graph-suppressed',
      source: 'MANUAL_UNBAN',
      reason: 'manual false positive',
    });
    const result = await service.recordObservation({
      userId: 'user-graph-suppressed',
      source: 'COMMERCIAL_AD',
      score: 0.58,
      reason: 'COMMERCIAL_AD_DETECTED',
      chatId: 'chat-2',
      evidence: { excerpt: 'Реклама услуги на https://bad.example/order сегодня' },
    });

    expect(result).toEqual(
      expect.objectContaining({
        outcome: 'suppressed',
        aggregateScore: 0,
      }),
    );
    expect(
      observations.filter(
        (row) => row.userId === 'user-graph-suppressed' && row.source.startsWith('GRAPH_'),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          suppressedAt: expect.any(Date),
          suppressionReason: 'manual false positive',
        }),
      ]),
    );
  });

  it('evaluates the spammer toggle through an explicit policy decision', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    const expiresAt = new Date(Date.now() + 60_000);
    prisma.globalSpammer.findUnique.mockResolvedValue({
      userId: 'user-policy-1',
      confidenceScore: 0.94,
      lastReason: 'HIGH_FANOUT_6_CHATS_2M',
      expiresAt,
      sourceBreakdown: { FANOUT_HIGH: { score: 0.94 } },
    });

    await expect(
      service.evaluatePolicy({
        chatId: 'chat-1',
        userId: 'user-policy-1',
        trigger: 'message',
        deleteSpammersEnabled: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        registryStatus: 'ACTIVE_CONFIRMED',
        action: 'DELETE_AND_KICK',
        wouldEnforce: true,
      }),
    );

    await expect(
      service.evaluatePolicy({
        chatId: 'chat-1',
        userId: 'user-policy-1',
        trigger: 'message',
        deleteSpammersEnabled: true,
        enforcementMode: 'shadow',
        recordDecision: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        action: 'SHADOW_DELETE_AND_KICK',
        shadow: true,
        enforced: false,
      }),
    );
    expect(prisma.globalSpammerEnforcementDecision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          decision: 'SHADOW_DELETE_AND_KICK',
          enforced: false,
          shadow: true,
          policyBand: 'CONFIRMED',
        }),
      }),
    );

    await service.evaluatePolicy({
      chatId: 'chat-1',
      userId: 'user-policy-1',
      trigger: 'message',
      deleteSpammersEnabled: true,
      recordDecision: true,
    });
    expect(prisma.globalSpammerEnforcementDecision.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          decision: 'DELETE_AND_KICK',
          enforced: false,
          shadow: false,
          policyBand: 'CONFIRMED',
        }),
      }),
    );

    await expect(
      service.evaluatePolicy({
        chatId: 'chat-1',
        userId: 'user-policy-1',
        trigger: 'message',
        deleteSpammersEnabled: true,
        adminExempt: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        registryStatus: 'ADMIN_EXEMPT',
        action: 'NONE',
      }),
    );
  });

  it('records shadow and campaign context with policy decisions', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);

    await service.recordObservation({
      userId: 'user-policy-context',
      source: 'FANOUT_HIGH',
      score: 0.94,
      reason: 'FANOUT_EPISODE_CONFIRMED',
      chatId: 'chat-policy',
      evidence: {
        uniqueChats: 6,
        windowSec: 120,
        excerpt: 'Одинаковая рассылка https://context.example/join сегодня',
      },
      forceRegistry: true,
    });

    await expect(
      service.evaluatePolicy({
        chatId: 'chat-policy',
        userId: 'user-policy-context',
        trigger: 'message',
        deleteSpammersEnabled: true,
        recordDecision: true,
        riskContextMode: 'full',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        registryStatus: 'ACTIVE_CONFIRMED',
        policyBand: 'CONFIRMED',
        shadowScore: expect.any(Number),
        campaignBreakdown: expect.any(Object),
      }),
    );

    expect(prisma.globalSpammerEnforcementDecision.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          policyBand: 'CONFIRMED',
          shadowScore: expect.any(Number),
          campaignBreakdown: expect.any(Object),
        }),
      }),
    );
  });

  it('keeps policy decision hot path off shadow and campaign risk queries by default', async () => {
    const { prisma, shadowScores } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    const expiresAt = new Date(Date.now() + 60_000);
    shadowScores.push({
      id: 'shadow-policy-light',
      userId: 'user-policy-light',
      chatId: 'chat-policy',
      messageId: null,
      observationId: 'obs-policy-light',
      trigger: 'test',
      currentScore: 0.7,
      v2Score: 0.86,
      scoreDelta: 0.16,
      currentBand: 'HIGH',
      v2Band: 'CONFIRMED',
      wouldPromote: true,
      wouldSuppress: false,
      humanReviewOutcome: null,
      reviewedAt: null,
      reviewedByUserId: null,
      sourceBreakdown: {},
      campaignBreakdown: {},
      createdAt: new Date(),
    });
    prisma.globalSpammer.findUnique.mockResolvedValueOnce({
      userId: 'user-policy-light',
      confidenceScore: 0.94,
      lastReason: 'FANOUT_EPISODE_CONFIRMED',
      expiresAt,
      sourceBreakdown: { FANOUT_HIGH: { score: 0.94 } },
    });

    await expect(
      service.evaluatePolicy({
        chatId: 'chat-policy',
        userId: 'user-policy-light',
        trigger: 'message',
        deleteSpammersEnabled: true,
        recordDecision: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        registryStatus: 'ACTIVE_CONFIRMED',
        action: 'DELETE_AND_KICK',
        shadowScore: null,
        campaignBreakdown: null,
      }),
    );

    expect(prisma.globalSpammerShadowScore.findFirst).not.toHaveBeenCalled();
    expect(prisma.spammerCampaignClusterMember.findMany).not.toHaveBeenCalled();
    expect(prisma.globalSpammerEnforcementDecision.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-policy-light',
          decision: 'DELETE_AND_KICK',
          shadowScore: null,
          campaignBreakdown: expect.any(Object),
        }),
      }),
    );
  });

  it('stores the local decision and feedback together and ignores an identical repeat', async () => {
    const { prisma, reviewFeedback } = createPrismaMock();
    const visit = jest.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const record = jest.fn().mockResolvedValue({ count: 1 });
    const transaction = {
      adminGlobalSpammerExemption: { createMany: visit, updateMany },
      globalSpammerReviewFeedback: prisma.globalSpammerReviewFeedback,
      spammerObservation: { createMany: record },
    };
    prisma.$transaction.mockImplementation(async (operation) => {
      const run = operation as unknown as (tx: typeof transaction) => Promise<unknown>;
      return Promise.resolve([await run(transaction)]);
    });
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    const input = {
      chatId: 'chat-review',
      userId: 'user-review-feedback',
      reviewerUserId: 'admin-reviewer',
      action: 'SUPPRESS' as const,
      reason: 'false positive from local context',
    };

    await expect(service.reviewCandidate(input)).resolves.toMatchObject({ status: 'SUPPRESSED' });
    await expect(service.reviewCandidate(input)).resolves.toMatchObject({ status: 'SUPPRESSED' });

    expect(reviewFeedback).toEqual([
      expect.objectContaining({
        chatId: 'chat-review',
        reviewerUserId: 'admin-reviewer',
        action: 'SUPPRESS',
      }),
    ]);
    expect(record).toHaveBeenCalledTimes(1);
    expect(prisma.globalSpammerCandidate.updateMany).not.toHaveBeenCalled();
    expect(prisma.globalSpammerShadowScore.updateMany).not.toHaveBeenCalled();
  });

  it('keeps suppressed and expired users out of enforcement', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(prisma as never);
    await service.recordSuppression({
      userId: 'user-policy-2',
      source: 'MANUAL_UNBAN',
      reason: 'manual false positive',
    });

    await expect(
      service.evaluatePolicy({
        chatId: 'chat-1',
        userId: 'user-policy-2',
        trigger: 'message',
        deleteSpammersEnabled: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        registryStatus: 'SUPPRESSED',
        action: 'NONE',
      }),
    );

    prisma.globalSpammerSuppression.findFirst.mockResolvedValueOnce(null);
    prisma.globalSpammer.findUnique.mockResolvedValueOnce({
      userId: 'user-policy-3',
      confidenceScore: 0.9,
      lastReason: 'old legacy row',
      expiresAt: new Date(Date.now() - 60_000),
      sourceBreakdown: {},
    });
    await expect(
      service.evaluatePolicy({
        chatId: 'chat-1',
        userId: 'user-policy-3',
        trigger: 'message',
        deleteSpammersEnabled: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        registryStatus: 'EXPIRED',
        action: 'NONE',
      }),
    );
  });

  it('uses fresh runtime profile read-model for policy decisions when enabled', async () => {
    const { prisma, runtimeProfiles } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(
      prisma as never,
      createConfigMock({
        SPAMMER_PROFILE_CACHE_ENABLED: 'true',
        SPAMMER_READ_MODEL_ENFORCEMENT_ENABLED: 'true',
      }),
    );
    runtimeProfiles.set('user-runtime-hit', {
      userId: 'user-runtime-hit',
      registryStatus: 'ACTIVE_CONFIRMED',
      action: 'DELETE_AND_KICK',
      confidenceScore: 0.97,
      shadowScore: 0.98,
      policyBand: 'CONFIRMED',
      reason: 'REVIEW_APPROVED',
      expiresAt: new Date(Date.now() + 60_000),
      suppressedUntil: null,
      sourceBreakdown: { REVIEW_APPROVED: { score: 1 } },
      campaignBreakdown: { cluster1: { scoreContribution: 0.12 } },
      sourceVersion: 3,
      staleAfter: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      service.evaluatePolicy({
        chatId: 'chat-1',
        userId: 'user-runtime-hit',
        trigger: 'message',
        deleteSpammersEnabled: true,
        recordDecision: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        registryStatus: 'ACTIVE_CONFIRMED',
        action: 'DELETE_AND_KICK',
        reason: 'REVIEW_APPROVED',
        shadowScore: 0.98,
        campaignBreakdown: { cluster1: { scoreContribution: 0.12 } },
      }),
    );

    expect(prisma.globalSpammerRuntimeProfile.findUnique).toHaveBeenCalledWith({
      where: { userId: 'user-runtime-hit' },
    });
    expect(prisma.globalSpammer.findUnique).not.toHaveBeenCalled();
    expect(prisma.globalSpammerCandidate.findUnique).not.toHaveBeenCalled();
    expect(prisma.globalSpammerSuppression.findFirst).not.toHaveBeenCalled();
    expect(prisma.globalSpammerEnforcementDecision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-runtime-hit',
          decision: 'DELETE_AND_KICK',
          shadowScore: 0.98,
          campaignBreakdown: { cluster1: { scoreContribution: 0.12 } },
        }),
      }),
    );
  });

  it('falls back to heavy policy lookup when runtime profile is stale', async () => {
    const { prisma, runtimeProfiles } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(
      prisma as never,
      createConfigMock({
        SPAMMER_PROFILE_CACHE_ENABLED: 'true',
        SPAMMER_READ_MODEL_ENFORCEMENT_ENABLED: 'true',
      }),
    );
    runtimeProfiles.set('user-runtime-stale', {
      userId: 'user-runtime-stale',
      registryStatus: 'ACTIVE_CONFIRMED',
      action: 'DELETE_AND_KICK',
      confidenceScore: 0.97,
      shadowScore: null,
      policyBand: 'CONFIRMED',
      reason: 'STALE',
      expiresAt: new Date(Date.now() - 60_000),
      suppressedUntil: null,
      sourceBreakdown: {},
      campaignBreakdown: null,
      sourceVersion: 3,
      staleAfter: new Date(Date.now() - 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.globalSpammer.findUnique.mockResolvedValueOnce({
      userId: 'user-runtime-stale',
      confidenceScore: 0.88,
      lastReason: 'FRESH_REGISTRY',
      expiresAt: new Date(Date.now() + 60_000),
      sourceBreakdown: { FANOUT_HIGH: { score: 0.9 } },
    });

    await expect(
      service.evaluatePolicy({
        chatId: 'chat-1',
        userId: 'user-runtime-stale',
        trigger: 'message',
        deleteSpammersEnabled: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        registryStatus: 'ACTIVE_CONFIRMED',
        action: 'DELETE_AND_KICK',
        reason: 'FRESH_REGISTRY',
      }),
    );

    expect(prisma.globalSpammer.findUnique).toHaveBeenCalled();
  });

  it('shadow-compares runtime profile decisions without using them for enforcement', async () => {
    const { prisma, runtimeProfiles } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(
      prisma as never,
      createConfigMock({
        SPAMMER_PROFILE_CACHE_ENABLED: 'true',
        SPAMMER_READ_MODEL_SHADOW_ENABLED: 'true',
      }),
    );
    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    runtimeProfiles.set('user-runtime-shadow', {
      userId: 'user-runtime-shadow',
      registryStatus: 'ACTIVE_CONFIRMED',
      action: 'DELETE_AND_KICK',
      confidenceScore: 0.99,
      shadowScore: null,
      policyBand: 'CONFIRMED',
      reason: 'STALE_BUT_FAST',
      expiresAt: new Date(Date.now() + 60_000),
      suppressedUntil: null,
      sourceBreakdown: { FANOUT_HIGH: { score: 0.99 } },
      campaignBreakdown: null,
      sourceVersion: 3,
      staleAfter: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.globalSpammer.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.evaluatePolicy({
        chatId: 'chat-1',
        userId: 'user-runtime-shadow',
        trigger: 'message',
        deleteSpammersEnabled: true,
        recordDecision: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        registryStatus: 'NONE',
        action: 'NONE',
        reason: 'NO_ACTIVE_REGISTRY_ENTRY',
      }),
    );

    expect(prisma.globalSpammer.findUnique).toHaveBeenCalledWith({
      where: { userId: 'user-runtime-shadow' },
    });
    expect(prisma.globalSpammerEnforcementDecision.create).toHaveBeenCalledTimes(1);
    expect(prisma.globalSpammerEnforcementDecision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-runtime-shadow',
          decision: 'NONE',
          registryStatus: 'NONE',
        }),
      }),
    );
    await flushPromises();

    expect(prisma.globalSpammerRuntimeProfile.findUnique).toHaveBeenCalledWith({
      where: { userId: 'user-runtime-shadow' },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'global_spammer_read_model_shadow_compare',
        matched: false,
        userId: 'user-runtime-shadow',
        mismatches: expect.arrayContaining(['registryStatus', 'action', 'policyBand']),
        runtime: expect.objectContaining({
          registryStatus: 'ACTIVE_CONFIRMED',
          action: 'DELETE_AND_KICK',
        }),
        fallback: expect.objectContaining({
          registryStatus: 'NONE',
          action: 'NONE',
        }),
      }),
    );
  });

  it('logs matching runtime profile shadow comparisons while keeping the heavy-path result', async () => {
    const { prisma, runtimeProfiles } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(
      prisma as never,
      createConfigMock({
        SPAMMER_PROFILE_CACHE_ENABLED: 'true',
        SPAMMER_READ_MODEL_SHADOW_ENABLED: 'true',
      }),
    );
    const debugSpy = jest
      .spyOn((service as any).logger, 'debug')
      .mockImplementation(() => undefined);
    const expiresAt = new Date(Date.now() + 60_000);
    const sourceBreakdown = { REVIEW_APPROVED: { score: 1 } };
    runtimeProfiles.set('user-runtime-shadow-match', {
      userId: 'user-runtime-shadow-match',
      registryStatus: 'ACTIVE_CONFIRMED',
      action: 'DELETE_AND_KICK',
      confidenceScore: 0.93,
      shadowScore: null,
      policyBand: 'CONFIRMED',
      reason: 'REVIEW_APPROVED',
      expiresAt,
      suppressedUntil: null,
      sourceBreakdown,
      campaignBreakdown: null,
      sourceVersion: 3,
      staleAfter: expiresAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.globalSpammer.findUnique.mockResolvedValueOnce({
      userId: 'user-runtime-shadow-match',
      confidenceScore: 0.93,
      lastReason: 'REVIEW_APPROVED',
      expiresAt,
      sourceBreakdown,
    });

    await expect(
      service.evaluatePolicy({
        chatId: 'chat-1',
        userId: 'user-runtime-shadow-match',
        trigger: 'message',
        deleteSpammersEnabled: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        registryStatus: 'ACTIVE_CONFIRMED',
        action: 'DELETE_AND_KICK',
        reason: 'REVIEW_APPROVED',
      }),
    );

    expect(prisma.globalSpammer.findUnique).toHaveBeenCalled();

    await flushPromises();

    expect(prisma.globalSpammerRuntimeProfile.findUnique).toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'global_spammer_read_model_shadow_compare',
        matched: true,
        userId: 'user-runtime-shadow-match',
        mismatches: [],
      }),
    );
  });

  it('treats shadow score drift as matched when the runtime decision outcome is identical', async () => {
    const { prisma, runtimeProfiles } = createPrismaMock();
    const runtimeDiagnostics = {
      recordSpammerReadModelEvents: jest.fn().mockResolvedValue(undefined),
    };
    const service = new GlobalSpammerIntelligenceService(
      prisma as never,
      createConfigMock({
        SPAMMER_PROFILE_CACHE_ENABLED: 'true',
        SPAMMER_READ_MODEL_SHADOW_ENABLED: 'true',
      }),
      undefined,
      undefined,
      undefined,
      runtimeDiagnostics as never,
    );
    const debugSpy = jest
      .spyOn((service as any).logger, 'debug')
      .mockImplementation(() => undefined);
    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    const expiresAt = new Date(Date.now() + 60_000);
    const sourceBreakdown = { FANOUT_HIGH: { score: 1 } };
    runtimeProfiles.set('user-runtime-shadow-score-drift', {
      userId: 'user-runtime-shadow-score-drift',
      registryStatus: 'ACTIVE_CONFIRMED',
      action: 'DELETE_AND_KICK',
      confidenceScore: 1,
      shadowScore: 1,
      policyBand: 'CONFIRMED',
      reason: 'FANOUT_EPISODE_CONFIRMED',
      expiresAt,
      suppressedUntil: null,
      sourceBreakdown,
      campaignBreakdown: null,
      sourceVersion: 3,
      staleAfter: expiresAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.globalSpammer.findUnique.mockResolvedValueOnce({
      userId: 'user-runtime-shadow-score-drift',
      confidenceScore: 1,
      lastReason: 'FANOUT_EPISODE_CONFIRMED',
      expiresAt,
      sourceBreakdown,
    });

    await expect(
      service.evaluatePolicy({
        chatId: 'chat-1',
        userId: 'user-runtime-shadow-score-drift',
        trigger: 'message',
        deleteSpammersEnabled: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        registryStatus: 'ACTIVE_CONFIRMED',
        action: 'DELETE_AND_KICK',
      }),
    );

    await flushPromises();

    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'global_spammer_read_model_shadow_compare',
      }),
    );
    expect(debugSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'global_spammer_read_model_shadow_compare',
        matched: true,
        scoreDrift: true,
        shadowScoreDelta: 1,
        mismatches: [],
      }),
    );
    expect(runtimeDiagnostics.recordSpammerReadModelEvents).toHaveBeenCalledWith({
      events: ['shadow_compared', 'shadow_matched', 'shadow_score_drift'],
      jobAgeMs: undefined,
    });
  });

  it('skips runtime profile shadow comparison outside the configured sample', async () => {
    const { prisma, runtimeProfiles } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(
      prisma as never,
      createConfigMock({
        SPAMMER_PROFILE_CACHE_ENABLED: 'true',
        SPAMMER_READ_MODEL_SHADOW_ENABLED: 'true',
        SPAMMER_READ_MODEL_SHADOW_SAMPLE_RATE: '0',
      }),
    );
    const debugSpy = jest
      .spyOn((service as any).logger, 'debug')
      .mockImplementation(() => undefined);
    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    runtimeProfiles.set('user-runtime-shadow-unsampled', {
      userId: 'user-runtime-shadow-unsampled',
      registryStatus: 'ACTIVE_CONFIRMED',
      action: 'DELETE_AND_KICK',
      confidenceScore: 0.99,
      shadowScore: null,
      policyBand: 'CONFIRMED',
      reason: 'SHOULD_NOT_READ',
      expiresAt: new Date(Date.now() + 60_000),
      suppressedUntil: null,
      sourceBreakdown: { FANOUT_HIGH: { score: 0.99 } },
      campaignBreakdown: null,
      sourceVersion: 3,
      staleAfter: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.globalSpammer.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.evaluatePolicy({
        chatId: 'chat-1',
        userId: 'user-runtime-shadow-unsampled',
        trigger: 'message',
        deleteSpammersEnabled: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        registryStatus: 'NONE',
        action: 'NONE',
      }),
    );

    expect(prisma.globalSpammerRuntimeProfile.findUnique).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'global_spammer_read_model_shadow_compare',
      }),
    );
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'global_spammer_read_model_shadow_compare',
      }),
    );
  });

  it('warms the runtime profile read-model from fallback policy decisions', async () => {
    const { prisma, runtimeProfiles } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(
      prisma as never,
      createConfigMock({
        SPAMMER_PROFILE_CACHE_ENABLED: 'true',
        SPAMMER_DENORM_ASYNC_ENABLED: 'false',
      }),
    );
    prisma.globalSpammer.findUnique.mockResolvedValueOnce({
      userId: 'user-runtime-warm',
      confidenceScore: 0.93,
      lastReason: 'REVIEW_APPROVED',
      expiresAt: new Date(Date.now() + 60_000),
      sourceBreakdown: { REVIEW_APPROVED: { score: 1 } },
    });

    await service.evaluatePolicy({
      chatId: 'chat-1',
      userId: 'user-runtime-warm',
      trigger: 'message',
      deleteSpammersEnabled: true,
    });

    expect(prisma.globalSpammerRuntimeProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-runtime-warm' },
        create: expect.objectContaining({
          registryStatus: 'ACTIVE_CONFIRMED',
          action: 'DELETE_AND_KICK',
          confidenceScore: 0.93,
          reason: 'REVIEW_APPROVED',
          sourceVersion: 3,
        }),
      }),
    );
    expect(runtimeProfiles.get('user-runtime-warm')).toEqual(
      expect.objectContaining({
        registryStatus: 'ACTIVE_CONFIRMED',
        action: 'DELETE_AND_KICK',
        reason: 'REVIEW_APPROVED',
      }),
    );
  });

  it('can default policy decisions to shadow mode from runtime config', async () => {
    const { prisma } = createPrismaMock();
    const service = new GlobalSpammerIntelligenceService(
      prisma as never,
      createConfigMock({ GLOBAL_SPAMMER_ENFORCEMENT_MODE: 'shadow' }),
    );
    prisma.globalSpammer.findUnique.mockResolvedValue({
      userId: 'user-policy-shadow',
      confidenceScore: 0.96,
      lastReason: 'REVIEW_APPROVED',
      expiresAt: new Date(Date.now() + 60_000),
      sourceBreakdown: { REVIEW_APPROVED: { score: 1 } },
    });

    await expect(
      service.evaluatePolicy({
        chatId: 'chat-1',
        userId: 'user-policy-shadow',
        trigger: 'message',
        deleteSpammersEnabled: true,
        recordDecision: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        action: 'SHADOW_DELETE_AND_KICK',
        enforcementMode: 'shadow',
        enforced: false,
        shadow: true,
      }),
    );
  });
});
