import { PrismaService } from '../../prisma/prisma.service';
import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  karavanPublicationChoiceListRequestSchema,
  karavanPublicationChoicesSchema,
  karavanPublicationChoiceSaveSchema,
  karavanPublicationChoiceSavedSchema,
  karavanMarketplaceResolveSchema,
  karavanMarketplaceResolveResultSchema,
  karavanShopFormatSchema,
  type KaravanMarketplaceResolveResult,
} from '@maxim/contracts/karavan-marketplace';
import type { MaxActionJob } from '../../max/max-client.service';
import { assertKaravanLegacyPublication } from './karavan-legacy-publication.guard';
import {
  KaravanMarketplaceAuthorityService,
  karavanHash,
} from './karavan-marketplace-authority.service';

export const karavanScopedPublicationSchema = z
  .object({
    chatId: z.string(),
    actorMaxUserId: z.string(),
    subjectMaxUserId: z.string(),
    sourceMessageId: z.string(),
    botId: z.string(),
    marketplaceId: z.string().uuid(),
    bindingGeneration: z.number().int().positive(),
    format: karavanShopFormatSchema.optional(),
    formatRevision: z.number().int().positive().optional(),
    storeId: z.string().uuid().nullable(),
    url: z.string().url(),
    sourceFingerprint: z.string().length(64),
  })
  .strict();
export type KaravanScopedPublication = z.infer<typeof karavanScopedPublicationSchema>;

@Injectable()
export class KaravanMarketplaceResolverService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KaravanMarketplaceResolverService.name);
  private expiryTimer?: ReturnType<typeof setInterval>;
  private pruning = false;
  onModuleInit() {
    if (this.config.get<string>('APP_ROLE') !== 'admin') return;
    this.expiryTimer = setInterval(() => {
      void this.pruneExpiredChoices();
    }, 60_000);
    this.expiryTimer.unref();
  }
  onModuleDestroy() {
    if (this.expiryTimer) clearInterval(this.expiryTimer);
  }
  async pruneExpiredChoices(): Promise<void> {
    if (this.pruning) return;
    this.pruning = true;
    try {
      await this.prisma
        .$executeRaw`DELETE FROM karavan_marketplace_publication_choices WHERE id IN (SELECT id FROM karavan_marketplace_publication_choices WHERE expires_at <= now() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`;
    } catch {
      this.logger.warn('Private marketplace choice expiry cleanup failed');
    } finally {
      this.pruning = false;
    }
  }
  constructor(
    private readonly config: ConfigService,
    private readonly authority: KaravanMarketplaceAuthorityService,
    private readonly prisma: PrismaService,
  ) {}
  async shouldUseScopedRelay(chatId: string): Promise<boolean> {
    // FLAG: Enrollment is durable even when the binding is disconnected or the feature is disabled.
    return !!(await this.prisma.karavanMarketplaceChatEnrollment.findUnique({
      where: { chatId },
      select: { chatId: true },
    }));
  }
  enabled(): boolean {
    return this.config.get<boolean>('KARAVAN_MARKETPLACE_ENABLED') === true;
  }

  private buyerUrl(publicSlug: string, storeSlug?: string): string {
    const base = new URL(this.config.getOrThrow<string>('KARAVAN_STOREFRONT_CATALOG_URL'));
    if (base.protocol !== 'https:' || base.hostname !== 'max.ru' || base.username || base.password)
      throw new ServiceUnavailableException('Ссылка магазина не настроена.');
    base.search = '';
    base.hash = '';
    base.searchParams.set('startapp', `m_${publicSlug}${storeSlug ? `__s_${storeSlug}` : ''}`);
    return base.href;
  }

  private async resolveCandidate(
    input: {
      chatId: string;
      actorMaxUserId: string;
      subjectMaxUserId: string;
      sourceMessageId: string;
      botId: string;
    },
    expected?: KaravanScopedPublication,
    choice?: { storeId: string; marketplaceId: string; bindingGeneration: number },
  ): Promise<{
    result: KaravanMarketplaceResolveResult;
    publication: KaravanScopedPublication | null;
    sourceFingerprint: string;
  }> {
    this.authority.assertEnabled();
    const payload = karavanMarketplaceResolveSchema.parse({
      commandId: `publication:${randomUUID()}`,
      chatId: input.chatId,
      subjectMaxUserId: input.subjectMaxUserId,
      sourceMessageId: input.sourceMessageId,
      storeId: expected?.storeId ?? choice?.storeId ?? null,
    });
    const issued = await this.authority.issuePublication(
      {
        actorMaxUserId: input.actorMaxUserId,
        chatId: input.chatId,
        commandId: payload.commandId,
        action: 'resolve_publication',
        marketplaceId: expected?.marketplaceId ?? choice?.marketplaceId ?? null,
        expectedBindingGeneration: expected?.bindingGeneration ?? choice?.bindingGeneration ?? null,
        payloadHash: karavanHash(payload),
      },
      input,
    );
    if (expected && expected.sourceFingerprint !== issued.sourceFingerprint)
      throw new ConflictException('Исходное сообщение изменилось.');
    let result: KaravanMarketplaceResolveResult;
    try {
      const response = await fetch(
        `${this.config.getOrThrow<string>('KARAVAN_MARKETPLACE_API_BASE_URL').replace(/\/$/u, '')}/api/v1/integrations/maxim/marketplaces/resolve`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.config.getOrThrow<string>('KARAVAN_MARKETPLACE_COMMAND_TOKEN')}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ authority: issued.authority, payload }),
          redirect: 'error',
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (!response.ok) throw new Error('Resolver rejected publication');
      result = karavanMarketplaceResolveResultSchema.parse(await response.json());
    } catch {
      throw new ServiceUnavailableException('Не удалось подтвердить витрину в этом чате.');
    }
    if (result.status === 'unbound')
      return { result, publication: null, sourceFingerprint: issued.sourceFingerprint };
    if (
      !result.marketplace ||
      !result.binding ||
      result.marketplace.status !== 'active' ||
      result.marketplace.kind !== 'chat'
    )
      throw new ConflictException('Магазин недоступен.');
    const format = result.marketplace.format ?? 'community';
    const formatRevision = result.marketplace.formatRevision ?? 1;
    // FLAG: A shared administration storefront never falls back to a catalog or a personal choice.
    if (format === 'storefront' && result.status !== 'published') {
      if (result.status === 'choose_store')
        throw new ConflictException('Общая витрина не подтверждена.');
      return { result, publication: null, sourceFingerprint: issued.sourceFingerprint };
    }
    if (result.status === 'choose_store')
      return { result, publication: null, sourceFingerprint: issued.sourceFingerprint };
    const store = result.status === 'published' ? result.stores[0] : null;
    if (result.status === 'published' && (result.stores.length !== 1 || !store))
      throw new ConflictException('Витрина не определена.');
    if (format === 'storefront' && result.marketplace.administrationStoreId !== store?.id)
      throw new ConflictException('Общая витрина изменилась.');
    const url = this.buyerUrl(result.marketplace.publicSlug, store?.slug);
    if (store && store.url !== url)
      throw new ConflictException('Адрес витрины не соответствует магазину.');
    const publication: KaravanScopedPublication = {
      ...input,
      marketplaceId: result.marketplace.id,
      bindingGeneration: result.binding.generation,
      format,
      formatRevision,
      storeId: store?.id ?? null,
      url,
      sourceFingerprint: issued.sourceFingerprint,
    };
    if (
      expected &&
      (expected.marketplaceId !== publication.marketplaceId ||
        expected.bindingGeneration !== publication.bindingGeneration ||
        (expected.format ?? 'community') !== format ||
        (expected.formatRevision ?? 1) !== formatRevision ||
        expected.storeId !== publication.storeId ||
        expected.url !== publication.url)
    )
      throw new ConflictException('Привязка или витрина изменились.');
    return { result, publication, sourceFingerprint: issued.sourceFingerprint };
  }

  async resolve(
    input: {
      chatId: string;
      actorMaxUserId: string;
      subjectMaxUserId: string;
      sourceMessageId: string;
      botId: string;
    },
    expected?: KaravanScopedPublication,
  ) {
    const result = await this.resolveCandidate(input, expected);
    if (
      result.result.status !== 'choose_store' ||
      expected ||
      !result.result.marketplace ||
      !result.result.binding
    )
      return result;
    const marketplace = result.result.marketplace;
    const binding = result.result.binding;
    const previous = await this.prisma.karavanMarketplacePublicationChoice.findUnique({
      where: {
        actorMaxUserId_chatId: { actorMaxUserId: input.actorMaxUserId, chatId: input.chatId },
      },
    });
    if (
      previous &&
      previous.expiresAt > new Date() &&
      previous.bindingGeneration === binding.generation &&
      previous.marketplaceId === marketplace.id &&
      previous.subjectMaxUserId === input.subjectMaxUserId &&
      previous.selectedStoreId
    ) {
      const selected = await this.resolveCandidate(input, undefined, {
        storeId: previous.selectedStoreId,
        marketplaceId: marketplace.id,
        bindingGeneration: binding.generation,
      });
      if (
        selected.result.status === 'published' &&
        selected.publication?.storeId === previous.selectedStoreId
      )
        return selected;
    }
    const samePrompt =
      previous &&
      !previous.selectedStoreId &&
      previous.expiresAt > new Date() &&
      previous.sourceFingerprint === result.sourceFingerprint &&
      previous.bindingGeneration === binding.generation &&
      previous.marketplaceId === marketplace.id;
    if (!samePrompt) {
      const data = {
        ...input,
        sourceFingerprint: result.sourceFingerprint,
        marketplaceId: marketplace.id,
        marketplaceName: marketplace.name,
        bindingGeneration: binding.generation,
        promptId: randomUUID(),
        stores: result.result.stores.map((store) => ({ id: store.id, name: store.name })),
        selectedStoreId: null,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      };
      await this.prisma.karavanMarketplacePublicationChoice.upsert({
        where: {
          actorMaxUserId_chatId: { actorMaxUserId: input.actorMaxUserId, chatId: input.chatId },
        },
        create: data,
        update: data,
      });
    }
    // A private choice only records intent. It never emits a generic/public fallback.
    return result;
  }

  async listChoices(raw: unknown) {
    this.authority.assertEnabled();
    const input = karavanPublicationChoiceListRequestSchema.parse(raw);
    const choices = await this.prisma.karavanMarketplacePublicationChoice.findMany({
      where: {
        actorMaxUserId: input.actorMaxUserId,
        ...(input.chatId ? { chatId: input.chatId } : {}),
        selectedStoreId: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });
    return karavanPublicationChoicesSchema.parse({
      choices: choices.map((choice) => ({
        id: choice.promptId,
        marketplaceId: choice.marketplaceId,
        marketplaceName: choice.marketplaceName,
        chatId: choice.chatId,
        expiresAt: choice.expiresAt.toISOString(),
        stores: choice.stores,
      })),
    });
  }

  async saveChoice(raw: unknown) {
    this.authority.assertEnabled();
    const input = karavanPublicationChoiceSaveSchema.parse(raw);
    const choice = await this.prisma.karavanMarketplacePublicationChoice.findFirst({
      where: {
        promptId: input.choiceId,
        actorMaxUserId: input.actorMaxUserId,
        ...(input.chatId ? { chatId: input.chatId } : {}),
        expiresAt: { gt: new Date() },
      },
    });
    if (!choice) throw new ConflictException('Выбор устарел. Повторите $ в нужном чате.');
    if (choice.selectedStoreId) {
      if (choice.selectedStoreId !== input.storeId)
        throw new ConflictException('Выбор уже сохранён.');
      return karavanPublicationChoiceSavedSchema.parse({ saved: true, storeId: input.storeId });
    }
    const fresh = await this.resolveCandidate(
      {
        actorMaxUserId: choice.actorMaxUserId,
        chatId: choice.chatId,
        subjectMaxUserId: choice.subjectMaxUserId,
        sourceMessageId: choice.sourceMessageId,
        botId: choice.botId,
      },
      undefined,
      {
        storeId: input.storeId,
        marketplaceId: choice.marketplaceId,
        bindingGeneration: choice.bindingGeneration,
      },
    );
    if (
      fresh.sourceFingerprint !== choice.sourceFingerprint ||
      fresh.result.status !== 'published' ||
      fresh.publication?.storeId !== input.storeId ||
      fresh.publication.bindingGeneration !== choice.bindingGeneration ||
      fresh.publication.marketplaceId !== choice.marketplaceId
    )
      throw new ConflictException('Витрина больше недоступна для этого чата.');
    const updated = await this.prisma.karavanMarketplacePublicationChoice.updateMany({
      where: {
        id: choice.id,
        promptId: input.choiceId,
        actorMaxUserId: input.actorMaxUserId,
        selectedStoreId: null,
        expiresAt: { gt: new Date() },
      },
      data: {
        selectedStoreId: input.storeId,
        sourceMessageId: 'selected',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      },
    });
    if (updated.count !== 1) throw new ConflictException('Запрос изменился. Обновите выбор.');
    return karavanPublicationChoiceSavedSchema.parse({ saved: true, storeId: input.storeId });
  }

  async assertDispatch(job: MaxActionJob, candidateBotId: string | null): Promise<void> {
    const raw = job.ledgerContext?.karavanMarketplacePublication;
    if (raw === undefined) return assertKaravanLegacyPublication(this.config, this.prisma, job);
    const publication = karavanScopedPublicationSchema.parse(raw);
    if (
      !this.enabled() ||
      this.config.get<boolean>('KARAVAN_STOREFRONT_RELAY_ENABLED') !== true ||
      job.actionType !== 'SEND_MESSAGE' ||
      publication.chatId !== job.chatId ||
      candidateBotId !== publication.botId ||
      job.routing?.requiredBotId !== publication.botId
    )
      throw new ConflictException('Публикация больше недоступна.');
    const result = await this.resolve(publication, publication);
    if (!result.publication) throw new ConflictException('Чат отключён от магазина.');
    // FLAG: The persisted button target is immutable: revalidation cannot silently retarget a queued send.
    const buttons = job.options?.buttons?.flat() ?? [];
    if (
      !buttons.some((button) => 'url' in button && button.url === publication.url) ||
      (publication.format === 'storefront' &&
        (buttons.length !== 1 || !('url' in buttons[0]) || buttons[0].url !== publication.url))
    )
      throw new ConflictException('Кнопка магазина изменилась.');
  }
}
