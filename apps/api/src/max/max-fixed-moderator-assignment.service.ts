import { readFixedModeratorSettingsPurposes } from './fixed-moderator-capabilities';
import { ConflictException, ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type ChatEntityType } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { MaxBotRegistryService } from './max-bot-registry.service';
import { canExecuteActionsForBotState } from './max-bot-state.util';
import { newerManagedEntityActorConflictWhere } from './managed-entity-activation.util';
import {
  executionRouteProof,
  type MaxExecutionAccessEpoch,
  type MaxExecutionOwnerState,
  type MaxExecutionPurpose,
} from './max-execution-route-proof';

const PURPOSES: readonly MaxExecutionPurpose[] = [
  'moderation',
  'delete_message',
  'send_message',
  'edit_message',
  'moderate_member',
];

export type FixedModeratorAssignmentInput = {
  operationId: string;
  chatId: string;
  entityType: ChatEntityType;
  botId: string;
  expectedRoutingVersion: number;
  expectedAccessEpoch: MaxExecutionAccessEpoch;
  actorProof: { userId: string; checkedAt: Date };
  preserveCurrent?: boolean;
};

/** Preserve existing capability coverage as well as the separately checked enabled duties. */
export function requiredFixedModeratorPurposes(
  state: MaxExecutionOwnerState,
): MaxExecutionPurpose[] {
  const legacy = { ...state, fixedModeratorBotId: null };
  return PURPOSES.filter(
    (purpose) =>
      purpose === 'moderation' ||
      purpose === 'delete_message' ||
      state.candidates.some((member) => executionRouteProof(legacy, member.botId, purpose)),
  );
}

@Injectable()
export class MaxFixedModeratorAssignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: MaxBotRegistryService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async assign(input: FixedModeratorAssignmentInput) {
    const bareActorId = input.actorProof.userId.replace(/^id(?=\d)/iu, '');
    const actorIds = [
      ...new Set([
        input.actorProof.userId,
        bareActorId,
        ...(/^\d+$/u.test(bareActorId) ? [`id${bareActorId}`] : []),
      ]),
    ];
    return this.prisma.$transaction(
      async (tx) => {
        // FLAG: Use the same parent-first, deterministic membership lock order as lifecycle
        // and ownership repair. Never perform MAX calls or await Redis under these locks.
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "chats" WHERE "id" = ${input.chatId} FOR UPDATE
      `);
        if (locked.length !== 1) throw new ConflictException('Сообщество больше недоступно.');
        const prior = await tx.managedModeratorAssignment.findUnique({
          where: { id: input.operationId },
        });
        if (prior) {
          if (
            prior.chatId !== input.chatId ||
            prior.actorUserId !== input.actorProof.userId ||
            prior.botId !== input.botId ||
            prior.expectedRoutingVersion !== input.expectedRoutingVersion
          )
            throw new ConflictException('Этот запрос уже использован. Откройте выбор бота заново.');
          return prior;
        }
        await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "chat_bot_memberships" WHERE "chat_id" = ${input.chatId}
        ORDER BY "bot_id", "id" FOR UPDATE
      `);
        await tx.$queryRaw(Prisma.sql`
        SELECT "bot_id" FROM "managed_entity_access_edges"
        WHERE "chat_id" = ${input.chatId} AND "user_id" IN (${Prisma.join(actorIds)})
        ORDER BY "user_id", "bot_id" FOR UPDATE
      `);
        const chat = await tx.chat.findUniqueOrThrow({
          where: { id: input.chatId },
          select: {
            entityType: true,
            primaryBotId: true,
            botId: true,
            fixedModeratorBotId: true,
            routingVersion: true,
            botMemberships: true,
          },
        });
        if (
          chat.entityType !== input.entityType ||
          chat.routingVersion !== input.expectedRoutingVersion
        )
          throw new ConflictException('Выбор бота уже изменился. Обновите список.');
        const currentBotId = chat.fixedModeratorBotId ?? chat.primaryBotId ?? chat.botId;
        if (input.preserveCurrent && currentBotId !== input.botId)
          throw new ConflictException('Действующий бот изменился. Закрепление отложено.');
        const checkedAt = input.actorProof.checkedAt.getTime();
        if (
          !Number.isFinite(checkedAt) ||
          checkedAt > Date.now() ||
          Date.now() - checkedAt > 30_000
        )
          throw new ForbiddenException('Проверка прав устарела. Повторите выбор бота.');
        const revoked = await tx.managedEntityAccessEdge.findFirst({
          where: newerManagedEntityActorConflictWhere(
            input.chatId,
            actorIds,
            input.botId,
            input.actorProof.checkedAt,
          ),
          select: { botId: true },
        });
        const activity = await tx.chatMembershipActivityEvent.findFirst({
          where: {
            chatId: input.chatId,
            userId: { in: actorIds },
            eventType: { in: ['user_added', 'user_removed'] },
            eventAt: { gte: input.actorProof.checkedAt },
          },
          select: { id: true },
        });
        if (revoked || activity)
          throw new ForbiddenException('Права администратора изменились. Обновите страницу.');
        const candidates = chat.botMemberships.filter((member) => {
          const bot = this.registry.getBotById(member.botId);
          return bot && canExecuteActionsForBotState(bot.state);
        });
        const state: MaxExecutionOwnerState = {
          chatId: input.chatId,
          entityType: chat.entityType,
          primaryBotId: currentBotId,
          routingVersion: chat.routingVersion,
          candidates,
        };
        // FLAG: Pin the saved duties through assignment commit; concurrent settings writes
        // wait for this decision. All reads remain exact chat-key probes, with no MAX calls.
        await tx.$queryRaw(Prisma.sql`
        SELECT "chat_id" FROM "chat_settings" WHERE "chat_id" = ${input.chatId} FOR SHARE
      `);
        await tx.$queryRaw(Prisma.sql`
        SELECT "chat_id" FROM "channel_settings" WHERE "chat_id" = ${input.chatId} FOR SHARE
      `);
        const required = new Set([
          ...requiredFixedModeratorPurposes(state),
          ...(await readFixedModeratorSettingsPurposes(
            tx,
            input.chatId,
            input.entityType,
            this.config?.get<boolean>('COMMERCIAL_LLM_ENFORCEMENT_ENABLED') === true,
          )),
        ]);
        const proof = executionRouteProof(state, input.botId);
        if (
          !proof ||
          proof.accessEpoch.checkedAt.getTime() !== input.expectedAccessEpoch.checkedAt.getTime() ||
          proof.accessEpoch.source !== input.expectedAccessEpoch.source ||
          [...required].some((purpose) => !executionRouteProof(state, input.botId, purpose))
        )
          throw new ConflictException('Боту не хватает прав для текущих функций сообщества.');

        const routingVersion = chat.routingVersion + 1;
        await tx.chat.update({
          where: { id: input.chatId },
          data: {
            fixedModeratorBotId: input.botId,
            primaryBotId: input.botId,
            botId: input.botId,
            routingVersion,
            routingState: 'READY',
          },
        });
        await tx.chatBotMembership.updateMany({
          where: { chatId: input.chatId, role: 'PRIMARY', botId: { not: input.botId } },
          data: { role: 'STANDBY' },
        });
        await tx.chatBotMembership.update({
          where: { chatId_botId: { chatId: input.chatId, botId: input.botId } },
          data: { role: 'PRIMARY' },
        });
        const operation = await tx.managedModeratorAssignment.create({
          data: {
            id: input.operationId,
            chatId: input.chatId,
            actorUserId: input.actorProof.userId,
            botId: input.botId,
            previousBotId: currentBotId,
            expectedRoutingVersion: input.expectedRoutingVersion,
            routingVersion,
          },
        });
        await tx.auditLog.create({
          data: {
            chatId: input.chatId,
            actorUserId: input.actorProof.userId,
            action: 'MODERATOR_ASSIGNED',
            payload: {
              operationId: input.operationId,
              previousBotId: currentBotId,
              botId: input.botId,
              routingVersion,
              preserveCurrent: input.preserveCurrent === true,
            },
          },
        });
        return operation;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 5_000 },
    );
  }
}
