import { KaravanMarketplaceResolverService } from './karavan-marketplace-resolver.service';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  karavanMarketplaceChatIdSchema,
  karavanMarketplaceHandoffIssueSchema,
  karavanMarketplaceSetupSchema,
  karavanMarketplacePreviewInputSchema,
  type KaravanPublicationPreview,
} from '@maxim/contracts/karavan-marketplace';
import { InitDataGuard } from '../../auth/init-data.guard';
import type { MiniappAuthContext } from '../../auth/miniapp-session.types';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator';
import {
  KaravanMarketplaceAuthorityService,
  karavanHash,
} from './karavan-marketplace-authority.service';
import { KaravanMarketplaceHandoffService } from './karavan-marketplace-handoff.service';
import { KaravanMarketplaceProxyService } from './karavan-marketplace-proxy.service';

type Request = FastifyRequest & { miniappAuth?: MiniappAuthContext };
@Controller('v1')
@UseGuards(InitDataGuard)
export class KaravanMarketplaceController {
  constructor(
    private readonly config: ConfigService,
    private readonly authority: KaravanMarketplaceAuthorityService,
    private readonly proxy: KaravanMarketplaceProxyService,
    private readonly resolver: KaravanMarketplaceResolverService,
    private readonly handoffs: KaravanMarketplaceHandoffService,
  ) {}

  @Get('chats/:chatId/karavan-marketplace')
  async module(
    @Param('chatId') rawChatId: string,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ) {
    const chatId = karavanMarketplaceChatIdSchema.parse(rawChatId);
    if (!this.config.get<boolean>('KARAVAN_MARKETPLACE_ENABLED'))
      return { enabled: false as const };
    const module = await this.proxy.module(
      chatId,
      user.userId,
      this.authority.principal(user, request.miniappAuth),
    );
    // FLAG: Use the relay's durable enrollment decision; a lost binding never previews legacy buttons.
    const scoped = await this.resolver.shouldUseScopedRelay(chatId);
    const publicationPreview: KaravanPublicationPreview = !scoped
      ? module.marketplace?.format === 'storefront'
        ? { mode: 'unavailable', reason: 'connection' }
        : { mode: 'catalog' }
      : !module.marketplace || module.binding?.state !== 'verified'
        ? { mode: 'unavailable', reason: 'connection' }
        : module.access?.reason !== 'allowed'
          ? { mode: 'unavailable', reason: 'verification' }
          : module.marketplace.status !== 'active'
            ? { mode: 'unavailable', reason: 'closed' }
            : module.marketplace.format === 'storefront'
              ? module.administrationStore?.id === module.marketplace.administrationStoreId &&
                module.administrationStore?.status === 'ACTIVE' &&
                !!module.buyerUrl
                ? { mode: 'administration_storefront' }
                : { mode: 'unavailable', reason: 'closed' }
              : { mode: 'chat_marketplace' };
    return {
      enabled: true as const,
      actorMaxUserId: user.userId,
      sellerBotUrl: `https://max.ru/${this.config.getOrThrow<string>('KARAVAN_SELLER_BOT_USERNAME')}`,
      ...module,
      publicationPreview:
        publicationPreview.mode === 'unavailable' && module.marketplace?.format
          ? { ...publicationPreview, format: module.marketplace.format }
          : publicationPreview,
      publicationChoices: (await this.resolver.listChoices({ actorMaxUserId: user.userId, chatId }))
        .choices,
      setupOperation: await this.proxy.activeSetup(user.userId, chatId),
    };
  }

  @Post('chats/:chatId/karavan-marketplace/manage')
  manage(
    @Param('chatId') rawChatId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ) {
    return this.proxy.manage(
      karavanMarketplaceChatIdSchema.parse(rawChatId),
      user.userId,
      body,
      this.authority.principal(user, request.miniappAuth),
    );
  }

  @Post('chats/:chatId/karavan-marketplace/publication-choice')
  async savePublicationChoice(
    @Param('chatId') rawChatId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ) {
    const chatId = karavanMarketplaceChatIdSchema.parse(rawChatId);
    const input = z
      .object({ choiceId: z.string().uuid(), storeId: z.string().uuid() })
      .strict()
      .parse(body);
    await this.proxy.module(
      chatId,
      user.userId,
      this.authority.principal(user, request.miniappAuth),
    );
    return this.resolver.saveChoice({ ...input, actorMaxUserId: user.userId, chatId });
  }

  @Get('chats/:chatId/karavan-marketplace/available')
  available(
    @Param('chatId') rawChatId: string,
    @Query('cursor') cursor: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ) {
    return this.proxy.available(
      karavanMarketplaceChatIdSchema.parse(rawChatId),
      user.userId,
      this.authority.principal(user, request.miniappAuth),
      z
        .string()
        .max(240)
        .nullable()
        .parse(cursor ?? null),
    );
  }

  @Post('chats/:chatId/karavan-marketplace/setup')
  setup(
    @Param('chatId') rawChatId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ) {
    const chatId = karavanMarketplaceChatIdSchema.parse(rawChatId);
    const input = karavanMarketplaceSetupSchema.parse(body);
    if (input.chatIds[0] !== chatId)
      throw new ForbiddenException('Текущий чат должен быть выбран для подключения.');
    return this.proxy.setup(
      user.userId,
      input,
      this.authority.principal(user, request.miniappAuth),
    );
  }

  @Get('chats/:chatId/karavan-marketplace/setup-options')
  setupOptions(
    @Param('chatId') rawChatId: string,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ) {
    return this.proxy.setupOptions(
      karavanMarketplaceChatIdSchema.parse(rawChatId),
      user.userId,
      this.authority.principal(user, request.miniappAuth),
    );
  }

  @Post('chats/:chatId/karavan-marketplace/preview')
  preview(
    @Param('chatId') rawChatId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ) {
    const chatId = karavanMarketplaceChatIdSchema.parse(rawChatId);
    const input = karavanMarketplacePreviewInputSchema.parse(body);
    if (input.chatIds[0] !== chatId)
      throw new ForbiddenException('Текущий чат должен быть выбран.');
    return this.proxy.preview(
      user.userId,
      input,
      this.authority.principal(user, request.miniappAuth),
    );
  }

  @Post('chats/:chatId/karavan-marketplace/bindings/:marketplaceId')
  bind(
    @Param('chatId') rawChatId: string,
    @Param('marketplaceId') rawMarketplaceId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ) {
    const chatId = karavanMarketplaceChatIdSchema.parse(rawChatId);
    const marketplaceId = z.string().uuid().parse(rawMarketplaceId);
    const input = z
      .object({
        commandId: z.string().uuid(),
        expectedBindingGeneration: z.number().int().positive().nullable(),
        action: z.enum(['bind_chat', 'unbind_chat', 'transfer_chat', 'recover_chat']),
      })
      .strict()
      .parse(body);
    const { action, ...payload } = input;
    return this.proxy.binding(
      marketplaceId,
      user.userId,
      { ...payload, chatId, ...(action === 'bind_chat' ? {} : { action }) },
      this.authority.principal(user, request.miniappAuth),
      action !== 'bind_chat',
    );
  }

  @Post('chats/:chatId/karavan-marketplace/operations/:operationId/cancel')
  cancelSetup(
    @Param('chatId') rawChatId: string,
    @Param('operationId') operationId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.proxy.cancelSetup(
      z.string().uuid().parse(operationId),
      user.userId,
      karavanMarketplaceChatIdSchema.parse(rawChatId),
    );
  }

  @Get('chats/:chatId/karavan-marketplace/operations/:operationId')
  async status(
    @Param('chatId') rawChatId: string,
    @Param('operationId') operationId: string,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ) {
    const chatId = karavanMarketplaceChatIdSchema.parse(rawChatId);
    await this.proxy.module(
      chatId,
      user.userId,
      this.authority.principal(user, request.miniappAuth),
      randomUUID(),
    );
    return this.proxy.status(z.string().uuid().parse(operationId), user.userId);
  }

  @Post('chats/:chatId/karavan-marketplace/handoffs')
  async handoff(
    @Param('chatId') rawChatId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ) {
    const chatId = karavanMarketplaceChatIdSchema.parse(rawChatId);
    const input = karavanMarketplaceHandoffIssueSchema.parse(body);
    const principal = this.authority.principal(user, request.miniappAuth);
    const module = await this.proxy.module(
      chatId,
      user.userId,
      principal,
      `handoff:${karavanHash(input)}:module`,
    );
    const requiredPermission =
      input.destination === 'applications'
        ? 'review_listing'
        : ['manage', 'view', 'preview'].includes(input.destination)
          ? null
          : 'manage_marketplace';
    if (
      !module.permissions.length ||
      (requiredPermission && !module.permissions.includes(requiredPermission)) ||
      module.marketplace?.id !== input.marketplaceId ||
      module.binding?.state !== 'verified'
    )
      throw new ForbiddenException('Управление этим магазином недоступно.');
    if (
      input.destination === 'storefront' &&
      (module.marketplace.format !== 'storefront' ||
        module.access?.reason !== 'allowed' ||
        !module.administrationStore ||
        module.administrationStore.id !== module.marketplace.administrationStoreId)
    )
      throw new ForbiddenException('Общая витрина не подтверждена.');
    if (
      (input.destination === 'view' && module.marketplace.status !== 'active') ||
      (input.destination === 'preview' &&
        !['draft', 'paused', 'active'].includes(module.marketplace.status))
    )
      throw new ForbiddenException('Просмотр этого магазина недоступен.');
    return this.handoffs.issue(chatId, user.userId, input, principal);
  }
}
