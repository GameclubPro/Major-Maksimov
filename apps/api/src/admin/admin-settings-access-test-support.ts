import { ConfigService } from '@nestjs/config';
import type { MaxClientService, MaxChatMemberAccess } from '../max/max-client.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '../prisma/prisma-client';
import { AdminService } from './admin.service';

function createManagedAccessEdgeFixture() {
  return {
    findFirst: jest
      .fn<
        Promise<Awaited<ReturnType<PrismaService['managedEntityAccessEdge']['findFirst']>>>,
        Parameters<PrismaService['managedEntityAccessEdge']['findFirst']>
      >()
      .mockResolvedValue(null),
    findUnique: jest
      .fn<
        Promise<Awaited<ReturnType<PrismaService['managedEntityAccessEdge']['findUnique']>>>,
        Parameters<PrismaService['managedEntityAccessEdge']['findUnique']>
      >()
      .mockResolvedValue(null),
    upsert: jest.fn<
      Promise<Awaited<ReturnType<PrismaService['managedEntityAccessEdge']['upsert']>>>,
      Parameters<PrismaService['managedEntityAccessEdge']['upsert']>
    >(async (input) => {
      const identity = input.where.chatId_userId_botId;
      if (!identity) throw new Error('Managed access fixture requires an exact edge identity');
      const at = new Date('2026-03-01T00:00:00.000Z');
      return {
        chatId: identity.chatId,
        userId: identity.userId,
        botId: identity.botId,
        entityType: 'CHAT',
        state: 'GRANTED',
        userRole: 'ADMIN',
        botRole: 'ADMIN',
        checkedAt: at,
        lastAdminConfirmedAt: null,
        expiresAt: null,
        deniedReason: null,
        lastMaxErrorCode: null,
        lastMaxErrorMessage: null,
        lastMaxStatusCode: null,
        source: 'fixture',
        sourceVersion: null,
        createdAt: at,
        updatedAt: at,
      };
    }),
  };
}

// FLAG: Feature fixtures declare their administrator set through the legacy list mock.
// Model exact human/bot evidence for settings without changing any supplied targeted mock.
export function createAdminServiceFixture(
  ...args: ConstructorParameters<typeof AdminService>
): AdminService {
  const config = args[3];
  if (!args[9]) {
    args[9] = new MaxBotRegistryService(
      new ConfigService({
        APP_BASE_URL: config.get<string>('APP_BASE_URL'),
        MAX_BOT_ID: config.get<string>('MAX_BOT_ID') ?? '777000_bot',
        MAX_BOT_TOKEN: config.getOrThrow<string>('MAX_BOT_TOKEN'),
        MAX_BOT_CONTACT_ID: config.get<string>('MAX_BOT_CONTACT_ID'),
        MAX_BOT_TOKEN_PREVIOUS: config.get<string>('MAX_BOT_TOKEN_PREVIOUS'),
        MAX_WEBHOOK_SECRET_PATH:
          config.get<string>('MAX_WEBHOOK_SECRET_PATH') ?? 'test-webhook-secret-path',
        MAX_WEBHOOK_HEADER_SECRET:
          config.get<string>('MAX_WEBHOOK_HEADER_SECRET') ?? 'test-webhook-header-secret',
        MAX_BOTS_JSON: config.get<string>('MAX_BOTS_JSON'),
        MAX_ENTRY_BOT_ID: config.get<string>('MAX_ENTRY_BOT_ID'),
        MAX_PUBLISHER_BOT_ID: config.get<string>('MAX_PUBLISHER_BOT_ID'),
      }),
    );
  }
  if (!args[0].managedEntityAccessEdge) {
    const prisma = args[0];
    const managedEntityAccessEdge = createManagedAccessEdgeFixture();
    // FLAG: Feature-only persistence must not change a shared Prisma fixture used by
    // another service. Overlay the same delegate inside its callback transactions.
    const transaction = async (
      input: unknown,
      options?: Parameters<PrismaService['$transaction']>[1],
    ): Promise<unknown> => {
      if (typeof input === 'function') {
        const work = input as (tx: Prisma.TransactionClient) => Promise<unknown>;
        return prisma.$transaction(
          (tx) => work({ ...tx, managedEntityAccessEdge } as unknown as Prisma.TransactionClient),
          options,
        );
      }
      return prisma.$transaction(input as Prisma.PrismaPromise<unknown>[], options);
    };
    args[0] = {
      ...prisma,
      managedEntityAccessEdge,
      $transaction: transaction as PrismaService['$transaction'],
    } as unknown as PrismaService;
  }
  const client = args[1];
  const readAdminIds = client.getChatAdminIds;
  if (typeof client.getChatMembersAccess !== 'function' && typeof readAdminIds === 'function') {
    const normalize = (value: string) =>
      value
        .trim()
        .toLowerCase()
        .replace(/^id(?=\d)/u, '');
    const access = (userId: string, isAdmin: boolean, isBot: boolean): MaxChatMemberAccess => ({
      userId,
      isBot,
      isAdmin,
      isOwner: false,
      permissions: [],
      explicitPrivilegeEvidence: isAdmin,
      explicitNonPrivilegeEvidence: !isAdmin,
    });
    const getChatMembersAccess = jest.fn<
      ReturnType<MaxClientService['getChatMembersAccess']>,
      Parameters<MaxClientService['getChatMembersAccess']>
    >(async (chatId, userIds, options = {}) => {
      const administratorIds = new Set(
        (await readAdminIds.call(client, chatId, options)).map(normalize),
      );
      const rows = new Map<string, MaxChatMemberAccess>();
      const actorId = userIds[0];
      if (actorId)
        rows.set(actorId, access(actorId, administratorIds.has(normalize(actorId)), false));
      // FLAG: The remaining lookup identities are exact bot contacts supplied by the
      // settings reader. Keep independent action-route self mocks unconsumed.
      for (const botId of userIds.slice(1)) rows.set(botId, access(botId, true, true));
      return rows;
    });
    const getCurrentChatMemberAccess =
      typeof client.getCurrentChatMemberAccess === 'function'
        ? client.getCurrentChatMemberAccess
        : jest.fn<
            ReturnType<MaxClientService['getCurrentChatMemberAccess']>,
            Parameters<MaxClientService['getCurrentChatMemberAccess']>
          >(async (_chatId, options = {}) => {
            const botId = options.botId ?? config.get<string>('MAX_BOT_ID') ?? '777000_bot';
            const botContactId =
              args[8]?.resolveContactIdSync?.(botId) ??
              args[9]?.getBotById?.(botId)?.contactId ??
              config.get<string>('MAX_BOT_CONTACT_ID') ??
              /^(?:id)?(\d+)(?:_|$)/u.exec(botId)?.[1] ??
              '777000';
            return access(botContactId, true, true);
          });
    args[1] = {
      ...client,
      getChatMembersAccess,
      getCurrentChatMemberAccess,
    } as unknown as MaxClientService;
  }
  return new AdminService(...args);
}

export function createBareAdminServiceForCatalogTests() {
  const service = Object.create(AdminService.prototype) as any;
  service.maxBotRegistry = {
    getBotById: jest.fn().mockReturnValue(null),
  };
  service.managedEntitiesRuntimeBotIds = new Set(['bot-1']);
  service.logger = {
    warn: jest.fn(),
  };
  return service;
}
