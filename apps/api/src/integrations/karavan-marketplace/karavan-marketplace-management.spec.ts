import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import { z } from 'zod';
import type { PrismaService } from '../../prisma/prisma.service';
import type { Prisma } from '../../prisma/prisma-client';
import type {
  KaravanMarketplaceAuthorityService,
  KaravanPrincipal,
} from './karavan-marketplace-authority.service';
import { KaravanMarketplaceProxyService } from './karavan-marketplace-proxy.service';
import { ManagementJournal } from './karavan-management-journal';
const principal: KaravanPrincipal = {
  source: 'session',
  principalKey: 'a'.repeat(64),
  launchBotId: 'synthetic',
};
describe('native Major shop commands', () => {
  beforeEach(() => {
    // The native journal suite owns persistence/races; these cases exercise the
    // provider transport and its typed error/response boundary through that port.
    jest
      .spyOn(ManagementJournal.prototype, 'run')
      .mockImplementation(async (_actor, _request, dispatch) => dispatch(async () => {}));
  });
  afterEach(() => jest.restoreAllMocks());
  function setup() {
    const authority = {
      issue: jest.fn().mockResolvedValue({ proofId: 'synthetic' }),
      assertPrincipal: jest.fn().mockResolvedValue(undefined),
    } satisfies Pick<KaravanMarketplaceAuthorityService, 'issue' | 'assertPrincipal'>;
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([]),
      karavanMarketplaceConnectionScope: { findUnique: jest.fn().mockResolvedValue(null) },
    } satisfies Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'> & {
      karavanMarketplaceConnectionScope: Pick<
        Prisma.TransactionClient['karavanMarketplaceConnectionScope'],
        'findUnique'
      >;
    };
    const prisma = {
      $transaction: jest.fn(async (work: (client: Prisma.TransactionClient) => Promise<unknown>) =>
        work(tx as unknown as Prisma.TransactionClient),
      ),
    };
    const service = new KaravanMarketplaceProxyService(
      prisma as unknown as PrismaService,
      authority as unknown as KaravanMarketplaceAuthorityService,
      new ConfigService({
        KARAVAN_MARKETPLACE_API_BASE_URL: 'https://synthetic.test/karavan',
        KARAVAN_MARKETPLACE_COMMAND_TOKEN: 'synthetic-command',
      }),
    );
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    const payload = {
      commandId: randomUUID(),
      chatId: '-999',
      marketplaceId: randomUUID(),
      expectedBindingGeneration: 3,
      command: { operation: 'pins' },
    };
    return { service, authority, fetchMock, payload };
  }
  it('uses the server selected chat and authenticated actor and validates the operation response', async () => {
    const { service, authority, fetchMock, payload } = setup();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ operation: 'pins', data: { revision: 2, offers: [] } }), {
        status: 200,
      }),
    );
    await expect(service.manage('-123', '777', payload, principal)).resolves.toMatchObject({
      operation: 'pins',
    });
    expect(ManagementJournal.prototype.run).not.toHaveBeenCalled();
    expect(authority.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-123',
        actorMaxUserId: '777',
        action: 'manage_shop',
        expectedBindingGeneration: 3,
      }),
      principal,
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://synthetic.test/karavan/api/v1/integrations/maxim/marketplaces/manage',
    );
    expect(JSON.parse(init!.body as string).payload.chatId).toBe('-123');
    expect(init!.redirect).toBe('error');
  });
  it('routes a daily write through durable admission with its original command identity', async () => {
    const { service, authority, fetchMock, payload } = setup();
    const command = {
      operation: 'pins_save',
      input: {
        commandId: payload.commandId,
        expectedRevision: 1,
        offers: [],
      },
    };
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          operation: 'pins_save',
          data: { revision: 2, offers: [] },
        }),
        { status: 200 },
      ),
    );
    await expect(
      service.manage('-123', '777', { ...payload, command }, principal),
    ).resolves.toMatchObject({ operation: 'pins_save' });
    expect(authority.assertPrincipal).toHaveBeenCalledWith(principal, '777');
    expect(ManagementJournal.prototype.run).toHaveBeenCalledWith(
      '777',
      expect.objectContaining({ commandId: payload.commandId, chatId: '-123', command }),
      expect.any(Function),
      expect.any(Function),
    );
  });
  it('preserves safe conflicts without exposing remote diagnostics', async () => {
    const { service, fetchMock, payload } = setup();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'MARKETPLACE_REVISION_CONFLICT',
          message: 'private database details',
        }),
        { status: 409 },
      ),
    );
    try {
      await service.manage('-123', '777', payload, principal);
      throw new Error('Expected conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(409);
      expect(JSON.stringify((error as HttpException).getResponse())).not.toContain('database');
    }
  });
  it.each(['MARKETPLACE_APPEARANCE_RETIRED', 'MARKETPLACE_ADMINISTRATION_MOVED'])(
    'preserves the definite retirement result %s for original command recovery',
    async (code) => {
      const { service, fetchMock, payload } = setup();
      fetchMock.mockResolvedValue(Response.json({ error: code, message: 'private provider detail' }, { status: 410 }));
      await expect(service.manage('-123', '777', payload, principal)).rejects.toMatchObject({
        status: 410,
        response: { code },
      });
    },
  );
  it('relays a personal grant with the exact recipient and original command identity', async () => {
    const { service, authority, fetchMock, payload } = setup();
    const expiresAt = '2026-12-01T00:00:00.000Z';
    const command = {
      operation: 'seller_grant_create',
      input: {
        commandId: payload.commandId,
        expectedPolicyRevision: 7,
        targetMaxUserId: '9007199254740993',
        storeId: null,
        expiresAt,
      },
    };
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          operation: 'seller_grant_create',
          data: {
            grant: {
              id: randomUUID(),
              marketplaceId: payload.marketplaceId,
              targetMaxUserId: command.input.targetMaxUserId,
              storeId: null,
              revision: 1,
              expiresAt,
              revokedAt: null,
              claimedAt: null,
            },
            url: 'https://max.ru/seller?startapp=personal',
          },
        }),
        { status: 200 },
      ),
    );
    await expect(
      service.manage('-123', '777', { ...payload, command }, principal),
    ).resolves.toMatchObject({
      operation: 'seller_grant_create',
      data: { grant: { targetMaxUserId: command.input.targetMaxUserId } },
    });
    expect(authority.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        actorMaxUserId: '777',
        chatId: '-123',
        commandId: payload.commandId,
        marketplaceId: payload.marketplaceId,
        expectedBindingGeneration: 3,
      }),
      principal,
    );
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).payload.command).toEqual(
      command,
    );
  });
  it.each([
    ['MARKETPLACE_FORMAT_LIMIT', 409],
    ['MARKETPLACE_FORMAT_CHANGED', 409],
    ['MARKETPLACE_ARCHIVED', 409],
    ['ADMINISTRATION_STORE_OWNER_REQUIRED', 403],
    ['ADMINISTRATION_STORE_REQUIRED', 409],
    ['ADMINISTRATION_STORE_NOT_READY', 409],
    ['ADMINISTRATION_STORE_UNAVAILABLE', 409],
    ['MARKETPLACE_LISTING_LIMIT', 409],
    ['MARKETPLACE_GRANTS_UNAVAILABLE', 409],
    ['MARKETPLACE_GRANT_ALREADY_CLAIMED', 409],
    ['MARKETPLACE_GRANT_REQUIRED', 403],
    ['MARKETPLACE_GRANT_STORE_OWNER', 403],
    ['MARKETPLACE_GRANT_UNAVAILABLE', 403],
    ['MARKETPLACE_INVITATION_EXPIRY', 400],
    ['MARKETPLACE_INVITATION_LIMIT', 409],
    ['MARKETPLACE_RULES_CHANGED', 409],
    ['PLACEMENT_REVIEW_REQUIRED', 409],
    ['SELLER_STOREFRONT_LIMIT', 409],
    ['MARKETPLACE_INDEPENDENT_REVIEW_REQUIRED', 403],
    ['MARKETPLACE_APPLICATION_STALE', 409],
    ['MARKETPLACE_APPLICATION_ALREADY_DECIDED', 409],
    ['MARKETPLACE_APPLICATION_NOT_FOUND', 404],
    ['PLACEMENT_NOT_FOUND', 404],
    ['MARKETPLACE_RULES_ACCEPTANCE_REQUIRED', 400],
    ['MARKETPLACE_RULES_UNAVAILABLE', 409],
    ['MARKETPLACE_NETWORK_LIMIT', 409],
    ['MARKETPLACE_LIMIT', 409],
    ['MARKETPLACE_STATUS_INVALID', 409],
    ['MARKETPLACE_CHAT_REQUIRED', 409],
    ['MARKETPLACE_EMPTY_CONFIRMATION', 409],
    ['MARKETPLACE_ORDER_CHANGED', 409],
    ['MARKETPLACE_REORDER_INVALID', 400],
  ])('preserves the safe %s rejection for management and creation', async (code, status) => {
    const { service, fetchMock, payload } = setup();
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: code, message: 'private database diagnostics' }), {
          status: Number(status),
        }),
    );
    for (const action of [
      () => service.manage('-123', '777', payload, principal),
      () =>
        service.command(
          '/create',
          {
            commandId: payload.commandId,
            chatId: '-123',
            actorMaxUserId: '777',
            action: 'create_marketplace',
            marketplaceId: null,
            expectedBindingGeneration: null,
          },
          { commandId: payload.commandId, name: 'Synthetic' },
          principal,
          z.unknown(),
        ),
    ]) {
      const error = await action().then(
        () => null,
        (cause: unknown) => cause,
      );
      expect(error).toBeInstanceOf(HttpException);
      expect(error).toMatchObject({
        status,
        response: {
          code,
          message: expect.stringMatching(/[А-Яа-яЁё]/u),
        },
      });
      const message = JSON.stringify((error as HttpException).getResponse());
      expect(message).not.toContain('private');
      expect(message).not.toContain('diagnostics');
      expect(message.length).toBeLessThan(400);
    }
  });
  it.each([
    [409, 'UNRECOGNIZED_PROVIDER_ERROR', 'KARAVAN_COMMAND_REJECTED'],
    [503, 'ADMINISTRATION_STORE_NOT_READY', 'KARAVAN_COMMAND_UNKNOWN'],
  ])(
    'keeps provider status %s and unmapped errors on the generic boundary',
    async (status, code, expected) => {
      const { service, fetchMock, payload } = setup();
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: code, message: 'private diagnostics' }), {
          status: Number(status),
        }),
      );
      await expect(service.manage('-123', '777', payload, principal)).rejects.toMatchObject({
        status: 503,
        response: { code: expected },
      });
    },
  );
  it('rejects invented proxy paths or actor overrides before issuing authority', async () => {
    const { service, authority, payload } = setup();
    await expect(
      service.manage(
        '-123',
        '777',
        { ...payload, command: { operation: 'proxy', path: '/operator' } },
        principal,
      ),
    ).rejects.toThrow();
    await expect(
      service.manage('-123', '777', { ...payload, actorMaxUserId: '888' }, principal),
    ).rejects.toThrow();
    expect(authority.issue).not.toHaveBeenCalled();
  });
  it('preserves a rejected recovery generation as a safe conflict instead of service unavailability', async () => {
    const { service, authority, fetchMock, payload } = setup();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'MARKETPLACE_BINDING_CHANGED',
          message: 'private upstream detail',
        }),
        { status: 409 },
      ),
    );
    await expect(
      service.binding(
        payload.marketplaceId,
        '777',
        {
          commandId: payload.commandId,
          chatId: '-123',
          expectedBindingGeneration: 3,
          action: 'recover_chat',
        },
        principal,
        true,
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'MARKETPLACE_BINDING_CHANGED' },
    });
    expect(authority.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'recover_chat',
        chatId: '-123',
        expectedBindingGeneration: 3,
      }),
      principal,
    );
  });
});
