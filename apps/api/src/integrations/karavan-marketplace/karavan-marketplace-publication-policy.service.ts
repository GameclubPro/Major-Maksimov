import {
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalKaravanMarketplaceJson } from '@maxim/contracts/karavan-marketplace';
import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { MaxClientService } from '../../max/max-client.service';
import { MaxBotRegistryService } from '../../max/max-bot-registry.service';
import {
  readKaravanPublicationSource,
  readKaravanSourceIdentity,
  readKaravanSourceRow,
} from '../karavan-storefront/karavan-publication-source';

export const karavanPublicationPrincipalSchema = z
  .object({
    source: z.literal('publication'),
    sourceMessageId: z.string().min(1).max(200),
    subjectMaxUserId: z.string().regex(/^\d{1,24}$/u),
    sourceFingerprint: z.string().length(64),
    policyHash: z.string().length(64),
  })
  .strict();
export type KaravanPublicationPrincipal = z.infer<typeof karavanPublicationPrincipalSchema>;
const digest = (input: unknown) =>
  createHash('sha256').update(canonicalKaravanMarketplaceJson(input)).digest('hex');
/** FLAG: Publication permission is independent from authority to manage the marketplace. */
@Injectable()
export class KaravanMarketplacePublicationPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly max: MaxClientService,
    private readonly registry: MaxBotRegistryService,
  ) {}

  async local(
    tx: Prisma.TransactionClient | PrismaService,
    chatId: string,
    actorMaxUserId: string,
  ) {
    const settings = await tx.chatSettings.findUnique({
      where: { chatId },
      select: { karavanStorefrontEnabled: true, karavanStorefrontAdminsOnly: true },
    });
    const grant = await tx.karavanStorefrontAllowlistEntry.findUnique({
      where: { chatId_userId: { chatId, userId: actorMaxUserId } },
      select: { id: true, expiresAt: true, updatedAt: true },
    });
    if (!settings?.karavanStorefrontEnabled)
      throw new ForbiddenException('Публикации витрин отключены.');
    return {
      settings,
      grant,
      policyHash: digest({ settings, grant: JSON.parse(JSON.stringify(grant)) }),
      allowlisted: !!grant && (!grant.expiresAt || grant.expiresAt.getTime() > Date.now()),
    };
  }

  async assertLocal(
    tx: Prisma.TransactionClient,
    chatId: string,
    actorMaxUserId: string,
    principal: KaravanPublicationPrincipal,
  ): Promise<void> {
    if ((await this.local(tx, chatId, actorMaxUserId)).policyHash !== principal.policyHash)
      throw new ConflictException('Правила публикации изменились.');
  }

  async capture(
    chatId: string,
    actorMaxUserId: string,
    subjectMaxUserId: string,
    sourceMessageId: string,
    requestedBotId: string,
  ) {
    const checkedAt = new Date();
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        entityType: true,
        fixedModeratorBotId: true,
        primaryBotId: true,
        botId: true,
        title: true,
      },
    });
    const botId = chat?.fixedModeratorBotId ?? chat?.primaryBotId ?? chat?.botId;
    if (
      chat?.entityType !== 'CHAT' ||
      !botId ||
      requestedBotId !== botId ||
      !this.registry.getActionableBots().some((bot) => bot.id === botId)
    )
      throw new ForbiddenException('Маршрут публикации не подтверждён.');
    const local = await this.local(this.prisma, chatId, actorMaxUserId);
    const options = {
      botId,
      bypassCache: true,
      trafficClass: 'interactive' as const,
      sourceTag: 'karavan_marketplace_publication',
      timeoutMs: 5_000,
    };
    const needAdmin = local.settings.karavanStorefrontAdminsOnly && !local.allowlisted;
    const results = await Promise.allSettled([
      this.max.getExactMessageRow(chatId, sourceMessageId, options),
      this.max.getCurrentChatMemberAccess(chatId, options),
      needAdmin
        ? this.max.getChatMemberAccess(chatId, actorMaxUserId, options)
        : Promise.resolve(null),
    ]);
    if (results.some((result) => result.status !== 'fulfilled'))
      throw new ServiceUnavailableException('MAX не подтвердил публикацию.');
    const message = results[0].status === 'fulfilled' ? results[0].value : null;
    const bot = results[1].status === 'fulfilled' ? results[1].value : null;
    const actor = results[2].status === 'fulfilled' ? results[2].value : null;
    if (!message || !bot)
      throw new ServiceUnavailableException('MAX пока не подтвердил публикацию.');
    if (
      !(bot.isAdmin || bot.isOwner) ||
      bot.explicitPrivilegeEvidence !== true ||
      (needAdmin &&
        (!actor ||
          actor.userId !== actorMaxUserId ||
          actor.isBot !== false ||
          !(actor.isAdmin || actor.isOwner) ||
          actor.explicitPrivilegeEvidence !== true))
    )
      throw new ForbiddenException('Публикация больше недоступна.');
    const body = readKaravanSourceRow(message.body);
    const sender = readKaravanSourceRow(message.sender);
    const source = readKaravanPublicationSource(message);
    const actualSubject = source?.kind === 'direct' ? actorMaxUserId : source?.senderId;
    if (
      readKaravanSourceIdentity(body?.mid, message.message_id) !== sourceMessageId ||
      readKaravanSourceIdentity(sender?.user_id, sender?.userId, sender?.id, message.sender_id) !==
        actorMaxUserId ||
      sender?.is_bot !== false ||
      actualSubject !== subjectMaxUserId ||
      !source?.text.startsWith('$')
    )
      throw new ForbiddenException('Исходное сообщение изменилось или не подтверждает продавца.');
    const principal: KaravanPublicationPrincipal = {
      source: 'publication',
      sourceMessageId,
      subjectMaxUserId,
      sourceFingerprint: digest({
        sourceMessageId,
        actorMaxUserId,
        subjectMaxUserId,
        text: source.text,
        direct: source.kind === 'direct',
      }),
      policyHash: local.policyHash,
    };
    return {
      chatId,
      actorMaxUserId,
      botId,
      checkedAt,
      chatTitle: chat.title.slice(0, 300),
      principal,
    };
  }
}
