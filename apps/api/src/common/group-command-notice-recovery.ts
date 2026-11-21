import type { MaxUpdate } from '@maxim/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  Prisma,
  type WebhookEvent,
  type WebhookExecutionClaim,
  type MaxActionLedgerEntry,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { WebhookLegacyHoldService } from '../webhook/webhook-legacy-hold.service';
import type { WebhookCanonicalExecutionContext } from '../moderation/webhook-canonical-execution.service';
import type { MaxClientService } from '../max/max-client.service';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import type { MaxExecutionOwnerReadinessService } from '../max/max-execution-owner-readiness.service';
import { executionRouteProof, type MaxExecutionRouteProof } from '../max/max-execution-route-proof';
import {
  MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE,
  wasMaxPreDispatchGuardRejected,
} from '../max/max-action-pre-dispatch-guard';
import {
  isMaxMutationOutcomeAmbiguous,
  wasMaxMessageSendAttempted,
} from '../max/max-mutation-outcome.util';
import { hasWebhookReplayFence } from '../webhook/webhook-execution-deadline';
import { buildWebhookSemanticEventKey } from '../webhook/webhook-semantic-event-key';
import { MULTIBOT_EXECUTION_AUTHORITY_VERSION } from '../webhook/webhook-semantic-authority';
import { WebhookPreparationDeferredError } from './webhook-preparation-deferred.error';
import {
  buildGroupCommandKey,
  GroupCommandAuthorityService,
  GroupCommandNoticeDeliveryError,
  type GroupCommandPermit,
} from './group-command-authority.service';
import {
  deliverGroupCommandNotice,
  groupCommandNoticeLedgerKey,
} from './group-command-notice-delivery';

type Journal = {
  kind: 'COMMAND_NOTICE_PENDING';
  authorityVersion: typeof MULTIBOT_EXECUTION_AUTHORITY_VERSION;
  webhookEventId: string;
  semanticKey: string;
  executionBotId: string;
  noticeBotId: string;
  deadlineAt: string;
  businessStartedAt: string;
  commandClaimId: string;
  commandSemanticKey: string;
  commandResultDigest: string;
  commandPreparedAt: string;
  ledgerKey: string;
  failureCode: string;
};
const LEASE_MS = 90_000;
const resultDigest = (result: unknown) =>
  createHash('sha256')
    .update(
      JSON.stringify(result, (_key, value: unknown) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([left], [right]) =>
                left < right ? -1 : left > right ? 1 : 0,
              ),
            )
          : value,
      ),
    )
    .digest('hex');
const validDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime());

function isUnattemptedSend(
  ledger: MaxActionLedgerEntry | null,
  journal: Pick<Journal, 'ledgerKey' | 'failureCode'>,
  chatId: string,
  botId: string,
): ledger is MaxActionLedgerEntry {
  return Boolean(
    ledger &&
    ledger.jobId === journal.ledgerKey &&
    ledger.actionType === 'SEND_MESSAGE' &&
    ledger.chatId === chatId &&
    ledger.botId === botId &&
    !ledger.ambiguous &&
    !ledger.terminal &&
    ledger.status === 'FAILED_RETRYABLE' &&
    ledger.lastErrorCode === journal.failureCode &&
    ledger.lastStatusCode === null &&
    ledger.dispatchToken === null &&
    ledger.dispatchStartedAt === null &&
    ledger.dispatchBotId === null &&
    ledger.remoteMessageId === null,
  );
}

function isCompletedSend(
  ledger: MaxActionLedgerEntry | null,
  journal: Journal,
  chatId: string,
): boolean {
  return Boolean(
    ledger &&
    ledger.jobId === journal.ledgerKey &&
    ledger.chatId === chatId &&
    ledger.actionType === 'SEND_MESSAGE' &&
    ledger.status === 'SUCCEEDED' &&
    !ledger.ambiguous &&
    ledger.botId === journal.noticeBotId &&
    ledger.remoteMessageId &&
    ledger.dispatchBotId === journal.noticeBotId &&
    validDate(ledger.completedAt),
  );
}

function readJournal(
  event: WebhookEvent,
  execution: WebhookExecutionClaim,
  command: WebhookExecutionClaim,
): Journal | null {
  const journal = execution.commandResult as unknown as Journal | null;
  const update = event.normalizedPayload as unknown as MaxUpdate;
  const result = command.commandResult as unknown as { noticeText?: unknown } | null;
  if (
    !journal ||
    journal.kind !== 'COMMAND_NOTICE_PENDING' ||
    !update.message ||
    update.type !== 'message_created' ||
    event.id !== execution.webhookEventId ||
    event.status === 'PROCESSED' ||
    event.status === 'DUPLICATE' ||
    hasWebhookReplayFence(event) ||
    !execution.enforced ||
    execution.status !== 'READY' ||
    !validDate(execution.preparedAt) ||
    !validDate(execution.businessStartedAt) ||
    !execution.executionBotId ||
    !validDate(event.executionDeadlineAt) ||
    journal.deadlineAt !== event.executionDeadlineAt.toISOString() ||
    journal.authorityVersion !== MULTIBOT_EXECUTION_AUTHORITY_VERSION ||
    journal.webhookEventId !== event.id ||
    journal.semanticKey !== buildWebhookSemanticEventKey(update) ||
    journal.semanticKey !== execution.semanticKey ||
    journal.executionBotId !== execution.executionBotId ||
    journal.businessStartedAt !== execution.businessStartedAt.toISOString() ||
    journal.commandClaimId !== command.id ||
    command.kind !== 'COMMAND' ||
    !command.enforced ||
    command.webhookEventId !== event.id ||
    command.executionBotId !== journal.noticeBotId ||
    typeof journal.noticeBotId !== 'string' ||
    !journal.noticeBotId ||
    !validDate(command.preparedAt) ||
    !result ||
    typeof result.noticeText !== 'string' ||
    !result.noticeText ||
    journal.commandSemanticKey !== command.semanticKey ||
    command.semanticKey !== buildGroupCommandKey(update.message.chatId, update.message.messageId) ||
    journal.commandResultDigest !== resultDigest(command.commandResult) ||
    journal.ledgerKey !== groupCommandNoticeLedgerKey(command.semanticKey) ||
    typeof journal.failureCode !== 'string' ||
    !journal.failureCode ||
    (command.status !== 'READY' && command.status !== 'COMPLETED') ||
    (command.status === 'READY' &&
      journal.commandPreparedAt !== command.preparedAt.toISOString()) ||
    (command.status === 'COMPLETED' &&
      (!validDate(command.completedAt) || command.leaseToken || command.leaseExpiresAt))
  )
    return null;
  return journal;
}

const recordedNoticeRecoveries = new WeakMap<WebhookCanonicalExecutionContext, Readonly<Journal>>();

// FLAG: Only a committed, locally certified unattempted notice may retain scheduling
// after its handler rejects. A stored kind string alone is not this handoff proof.
export function readRecordedGroupCommandNoticeRecovery(context: WebhookCanonicalExecutionContext) {
  return recordedNoticeRecoveries.get(context);
}

// FLAG: Only a live, exact original handler can certify a weak-set transport guard rejection.
// A missing ledger, error string, timeout, attempted POST or unknown outcome supplies no proof.
export async function recordGroupCommandNoticeRecovery(
  prisma: PrismaService,
  context: WebhookCanonicalExecutionContext,
  error: unknown,
): Promise<Journal | undefined> {
  if (
    !(error instanceof GroupCommandNoticeDeliveryError) ||
    !context.businessLeaseToken ||
    !wasMaxPreDispatchGuardRejected(error.cause) ||
    wasMaxMessageSendAttempted(error.cause) ||
    isMaxMutationOutcomeAmbiguous(error.cause, true)
  )
    return;
  const update = context.update;
  if (update.type !== 'message_created' || !update.message || !context.activeBotId) return;
  const failureCode = MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE;
  const recordedJournal = await prisma.$transaction(async (tx) => {
    const execution = await tx.webhookExecutionClaim.findFirst({
      where: { kind: 'EXECUTION', webhookEventId: context.webhookEvent.id },
    });
    const command = await tx.webhookExecutionClaim.findUnique({
      where: {
        kind_semanticKey: {
          kind: 'COMMAND',
          semanticKey: buildGroupCommandKey(update.message!.chatId, update.message!.messageId),
        },
      },
    });
    if (
      !validDate(execution?.businessStartedAt) ||
      !execution?.executionBotId ||
      !validDate(command?.preparedAt) ||
      !command ||
      !validDate(context.webhookEvent.executionDeadlineAt) ||
      !command.commandResult ||
      command.status !== 'READY'
    )
      return;
    const journal: Journal = {
      kind: 'COMMAND_NOTICE_PENDING',
      authorityVersion: MULTIBOT_EXECUTION_AUTHORITY_VERSION,
      webhookEventId: context.webhookEvent.id,
      semanticKey: execution.semanticKey,
      executionBotId: context.activeBotId!,
      businessStartedAt: execution.businessStartedAt.toISOString(),
      noticeBotId: command.executionBotId ?? context.activeBotId!,
      deadlineAt: context.webhookEvent.executionDeadlineAt.toISOString(),
      commandClaimId: command.id,
      commandSemanticKey: command.semanticKey,
      commandResultDigest: resultDigest(command.commandResult),
      commandPreparedAt: command.preparedAt.toISOString(),
      ledgerKey: groupCommandNoticeLedgerKey(command.semanticKey),
      failureCode,
    };
    const event = await tx.webhookEvent.findUnique({ where: { id: context.webhookEvent.id } });
    if (
      !event ||
      !isDeepStrictEqual(event.normalizedPayload, context.webhookEvent.normalizedPayload) ||
      !readJournal(event, { ...execution, commandResult: journal }, command)
    )
      return;
    const ledger = await tx.maxActionLedgerEntry.findUnique({
      where: { jobId: journal.ledgerKey },
    });
    if (!isUnattemptedSend(ledger, journal, update.message!.chatId, journal.noticeBotId)) return;
    journal.failureCode = ledger.lastErrorCode!;
    const recorded = await tx.webhookExecutionClaim.updateMany({
      where: {
        id: execution.id,
        kind: 'EXECUTION',
        webhookEventId: event.id,
        status: 'READY',
        enforced: true,
        executionBotId: journal.executionBotId,
        businessStartedAt: execution.businessStartedAt,
        leaseToken: context.businessLeaseToken,
        leaseExpiresAt: { gt: new Date() },
      },
      data: { commandResult: journal },
    });
    return recorded.count === 1 ? journal : undefined;
  });
  if (recordedJournal) recordedNoticeRecoveries.set(context, Object.freeze({ ...recordedJournal }));
  return recordedJournal;
}

export async function recoverGroupCommandNotice(
  prisma: PrismaService,
  max: MaxClientService,
  authority: GroupCommandAuthorityService,
  webhookEventId: string,
  dependencies?: { readiness?: MaxExecutionOwnerReadinessService; links?: MaxBotLinkService },
): Promise<boolean> {
  if (typeof prisma.webhookExecutionClaim?.findFirst !== 'function') return false;
  // A normal webhook pays one indexed owner lookup. Outbox mirror proxying still targets
  // the original owner; a mirror cannot acquire or replace this recovery authority.
  const execution = await prisma.webhookExecutionClaim.findFirst({
    where: {
      kind: 'EXECUTION',
      webhookEventId,
      commandResult: { path: ['kind'], equals: 'COMMAND_NOTICE_PENDING' },
    },
  });
  const initial = execution?.commandResult as unknown as Journal | null;
  if (!execution?.webhookEventId || initial?.kind !== 'COMMAND_NOTICE_PENDING') return false;
  const [event, command] = await Promise.all([
    prisma.webhookEvent.findUnique({ where: { id: execution.webhookEventId } }),
    prisma.webhookExecutionClaim.findUnique({ where: { id: initial.commandClaimId } }),
  ]);
  if (!event || !command) return false;
  const semanticKey = buildWebhookSemanticEventKey(event.normalizedPayload);
  if (!semanticKey) return false;
  const validJournal = readJournal(event, execution, command);
  if (!validJournal) return false;
  let journal: Journal = validJournal;
  const update = event.normalizedPayload as unknown as MaxUpdate;
  const chatId = update.message!.chatId;
  const ledger = await prisma.maxActionLedgerEntry.findUnique({
    where: { jobId: journal.ledgerKey },
  });
  const completedSend = isCompletedSend(ledger, journal, chatId);
  const legacyHolds = WebhookLegacyHoldService.forPrisma(prisma);
  if (!completedSend && (await legacyHolds?.isUpdateHeld(update))) {
    if (!(await legacyHolds!.readFreshCommandReceipt(event.id, update)))
      await legacyHolds!.assertUpdateAllowed(update);
  }
  if (command.status === 'COMPLETED' && !completedSend) return false;
  if (!completedSend && !isUnattemptedSend(ledger, journal, chatId, journal.noticeBotId))
    return false;
  const expired = !completedSend && event.executionDeadlineAt!.getTime() <= Date.now();

  const leaseToken = randomUUID();
  const acquired = await prisma.webhookExecutionClaim.updateMany({
    where: {
      id: execution.id,
      kind: 'EXECUTION',
      webhookEventId: event.id,
      status: 'READY',
      enforced: true,
      executionBotId: journal.executionBotId,
      businessStartedAt: execution.businessStartedAt,
      commandResult: { equals: journal as Prisma.InputJsonValue },
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date() } }],
    },
    data: { leaseToken, leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
  });
  if (acquired.count !== 1)
    throw new WebhookPreparationDeferredError('Command notice recovery already running', 1_000);
  let permit: GroupCommandPermit | null = null;
  const owned = () => ({
    id: execution.id,
    kind: 'EXECUTION' as const,
    webhookEventId: event.id,
    status: 'READY' as const,
    enforced: true,
    executionBotId: journal.executionBotId,
    businessStartedAt: execution.businessStartedAt,
    leaseToken,
    commandResult: { equals: journal as Prisma.InputJsonValue },
  });
  let noticeProof: MaxExecutionRouteProof | null = null;
  const assertOwned = async (beforeSend = false) => {
    const leaseExpiresAt = new Date(Date.now() + LEASE_MS);
    const renewed = await prisma.webhookExecutionClaim.updateMany({
      where: { ...owned(), leaseExpiresAt: { gt: new Date() } },
      data: { leaseExpiresAt },
    });
    const source = await prisma.webhookEvent.findUnique({ where: { id: event.id } });
    if (
      renewed.count !== 1 ||
      !source ||
      hasWebhookReplayFence(source) ||
      source.status !== event.status ||
      source.errorMessage !== event.errorMessage ||
      !isDeepStrictEqual(source.normalizedPayload, event.normalizedPayload) ||
      source.executionDeadlineAt?.toISOString() !== journal!.deadlineAt ||
      (beforeSend &&
        (source.executionDeadlineAt!.getTime() <= Date.now() ||
          !noticeProof ||
          !(await dependencies!.links!.verifyChatExecutionProof({
            chatId,
            botId: journal!.noticeBotId,
            routingVersion: noticeProof.routingVersion,
            accessEpoch: noticeProof.accessEpoch,
            purpose: 'send_message',
          }))))
    )
      throw new WebhookPreparationDeferredError('Command notice recovery authority changed', 1_000);
    const now = Date.now();
    if (
      beforeSend &&
      (source.executionDeadlineAt!.getTime() <= now ||
        leaseExpiresAt.getTime() <= now ||
        !validDate(permit?.leaseExpiresAt) ||
        permit.leaseExpiresAt.getTime() <= now)
    )
      throw new WebhookPreparationDeferredError(
        'Command notice recovery deadline or lease elapsed',
        1_000,
      );
    return leaseExpiresAt;
  };
  try {
    if (command.status === 'READY' && completedSend && (await legacyHolds?.isUpdateHeld(update))) {
      // FLAG: A held source may settle only its exact confirmed SEND receipt. No permit
      // capable of publishing is created, and the permanent legacy holds remain intact.
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM webhook_execution_claims WHERE id = ${command.id} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM max_action_ledger WHERE job_id = ${journal.ledgerKey} FOR UPDATE`;
        const current = await tx.webhookExecutionClaim.findUnique({ where: { id: command.id } });
        const action = await tx.maxActionLedgerEntry.findUnique({
          where: { jobId: journal.ledgerKey },
        });
        if (
          !current ||
          !readJournal(event, execution, current) ||
          !isCompletedSend(action, journal, chatId)
        )
          throw new WebhookPreparationDeferredError('Held command notice receipt changed', 1_000);
        const changed = await tx.webhookExecutionClaim.updateMany({
          where: {
            id: current.id,
            status: 'READY',
            commandResult: { equals: current.commandResult as Prisma.InputJsonValue },
            OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date() } }],
          },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(),
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        if (changed.count !== 1)
          throw new WebhookPreparationDeferredError(
            'Held command notice lease remains active',
            1_000,
          );
      });
    } else if (command.status === 'READY') {
      permit = await authority.claim(update, journal.noticeBotId);
      if (!permit || !permit.result || resultDigest(permit.result) !== journal.commandResultDigest)
        throw new WebhookPreparationDeferredError('Saved command notice lease unavailable', 1_000);
      await assertOwned();
      const stale =
        !completedSend && !expired && (await authority.closureNoticeDeadline(permit)) <= Date.now();
      if (expired || stale) {
        // FLAG: Settle only this exact, certified unattempted SEND. Neither a new
        // policy nor an expired deadline cancels an accepted or uncertain effect.
        await prisma.$transaction(async (tx) => {
          const source = await tx.webhookEvent.findUnique({ where: { id: event.id } });
          const action = await tx.maxActionLedgerEntry.findUnique({
            where: { jobId: journal.ledgerKey },
          });
          if (
            !source ||
            source.executionDeadlineAt?.toISOString() !== journal.deadlineAt ||
            (expired && source.executionDeadlineAt.getTime() > Date.now()) ||
            hasWebhookReplayFence(source) ||
            !isDeepStrictEqual(source.normalizedPayload, event.normalizedPayload) ||
            !isUnattemptedSend(action, journal, chatId, journal.noticeBotId)
          )
            throw new WebhookPreparationDeferredError('Command notice expiry proof changed', 1_000);
          await authority.assertOwned(permit!, tx);
          if (stale && (await authority.closureNoticeDeadline(permit!, tx)) > Date.now())
            throw new WebhookPreparationDeferredError('Group control notice policy changed', 1_000);
          const finishedAt = new Date();
          const terminalAction = await tx.maxActionLedgerEntry.updateMany({
            where: {
              id: action.id,
              status: 'FAILED_RETRYABLE',
              ambiguous: false,
              terminal: false,
              botId: journal.noticeBotId,
              dispatchToken: null,
              dispatchStartedAt: null,
              dispatchBotId: null,
              remoteMessageId: null,
              lastErrorCode: journal.failureCode,
              lastStatusCode: null,
              lastAttemptAt: action.lastAttemptAt,
              attemptCount: action.attemptCount,
            },
            data: {
              status: 'FAILED_TERMINAL',
              terminal: true,
              completedAt: finishedAt,
              lastErrorCode: stale ? 'COMMAND_NOTICE_SUPERSEDED' : 'COMMAND_NOTICE_EXPIRED',
              lastError: stale
                ? 'Group control notice superseded before dispatch'
                : 'Unattempted saved command notice expired',
            },
          });
          await authority.complete(permit!, tx);
          const terminalExecution = await tx.webhookExecutionClaim.updateMany({
            where: { ...owned(), leaseExpiresAt: { gt: new Date() } },
            data: {
              status: 'COMPLETED',
              completedAt: finishedAt,
              leaseToken: null,
              leaseExpiresAt: null,
              commandResult: {
                ...journal,
                kind: stale ? 'EXECUTION_FINISHED' : 'COMMAND_NOTICE_EXPIRED',
                ...(stale ? { noticeOutcome: 'superseded_before_dispatch' } : {}),
                finishedAt: finishedAt.toISOString(),
              },
            },
          });
          const terminalReceipt = await tx.webhookEvent.updateMany({
            where: {
              id: event.id,
              status: event.status,
              errorMessage: event.errorMessage,
              timeoutQuarantineExpiresAt: null,
              executionDeadlineAt: event.executionDeadlineAt,
              normalizedPayload: { equals: event.normalizedPayload as Prisma.InputJsonValue },
            },
            data: {
              status: 'PROCESSED',
              processedAt: finishedAt,
              errorMessage: null,
              nextEnqueueAt: null,
              queueName: null,
            },
          });
          if (
            terminalAction.count !== 1 ||
            terminalExecution.count !== 1 ||
            terminalReceipt.count !== 1
          )
            throw new WebhookPreparationDeferredError(
              'Command notice expiry authority changed',
              1_000,
            );
        });
        permit = null;
        return true;
      }
      if (!completedSend) {
        if (!dependencies?.readiness || !dependencies.links)
          throw new WebhookPreparationDeferredError(
            'Command notice execution route unavailable',
            1_000,
          );
        noticeProof = await dependencies!.readiness!.ensureReady({
          chatId,
          purpose: 'send_message',
          preferredBotId: journal.noticeBotId,
          force: true,
        });
        if (!noticeProof)
          throw new WebhookPreparationDeferredError(
            'Saved command notice has no eligible executor',
            1_000,
          );
        if (noticeProof.botId !== journal.noticeBotId) {
          const selected = noticeProof;
          const previousJournal = journal;
          const nextJournal = { ...journal, noticeBotId: selected.botId };
          await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM chats WHERE id = ${chatId} FOR UPDATE`;
            const [chat, membership, latestSource] = await Promise.all([
              tx.chat.findUniqueOrThrow({
                where: { id: chatId },
                select: { entityType: true, routingVersion: true },
              }),
              tx.chatBotMembership.findUnique({
                where: { chatId_botId: { chatId, botId: selected.botId } },
              }),
              tx.webhookEvent.findUnique({ where: { id: event.id } }),
            ]);
            const proof = membership
              ? executionRouteProof(
                  {
                    chatId,
                    entityType: chat.entityType,
                    primaryBotId: null,
                    routingVersion: chat.routingVersion,
                    candidates: [membership],
                  },
                  selected.botId,
                  'send_message',
                )
              : null;
            if (
              !latestSource ||
              latestSource.executionDeadlineAt?.toISOString() !== journal.deadlineAt ||
              latestSource.executionDeadlineAt.getTime() <= Date.now() ||
              hasWebhookReplayFence(latestSource) ||
              !isDeepStrictEqual(latestSource.normalizedPayload, event.normalizedPayload) ||
              !proof ||
              proof.routingVersion !== selected.routingVersion ||
              proof.accessEpoch.source !== selected.accessEpoch.source ||
              proof.accessEpoch.checkedAt.getTime() !== selected.accessEpoch.checkedAt.getTime()
            )
              throw new WebhookPreparationDeferredError('Command notice peer proof changed', 1_000);
            await authority.assertOwned(permit!, tx);
            const action = await tx.maxActionLedgerEntry.updateMany({
              where: {
                jobId: previousJournal.ledgerKey,
                botId: previousJournal.noticeBotId,
                actionType: 'SEND_MESSAGE',
                chatId,
                status: 'FAILED_RETRYABLE',
                ambiguous: false,
                terminal: false,
                lastErrorCode: previousJournal.failureCode,
                lastStatusCode: null,
                dispatchToken: null,
                dispatchStartedAt: null,
                dispatchBotId: null,
                remoteMessageId: null,
                lastAttemptAt: ledger!.lastAttemptAt,
                attemptCount: ledger!.attemptCount,
              },
              data: { botId: selected.botId },
            });
            const commandHandoff = await tx.webhookExecutionClaim.updateMany({
              where: {
                id: command.id,
                kind: 'COMMAND',
                webhookEventId: event.id,
                status: 'READY',
                enforced: true,
                executionBotId: previousJournal.noticeBotId,
                leaseToken: permit!.leaseToken,
                leaseExpiresAt: { gt: new Date() },
                commandResult: { equals: command.commandResult as Prisma.InputJsonValue },
              },
              data: { executionBotId: selected.botId },
            });
            const executionHandoff = await tx.webhookExecutionClaim.updateMany({
              where: { ...owned(), leaseExpiresAt: { gt: new Date() } },
              data: { commandResult: nextJournal },
            });
            if (action.count !== 1 || commandHandoff.count !== 1 || executionHandoff.count !== 1)
              throw new WebhookPreparationDeferredError(
                'Command notice handoff authority changed',
                1_000,
              );
          });
          journal = nextJournal;
          permit.executionBotId = selected.botId;
        }
        const settings = await prisma.chatSettings.findUniqueOrThrow({ where: { chatId } });
        await assertOwned(true);
        await deliverGroupCommandNotice({
          max,
          authority,
          permit,
          settings,
          beforeMutation: () => assertOwned(true),
        });
      }
      await authority.complete(permit);
      permit = null;
    } else if (!completedSend) return false;
    await assertOwned();
    // FLAG: A successful SEND is SQL settlement evidence only. Recovery never re-enters
    // rules, re-applies settings, changes the handler executor or dispatches an unknown SEND.
    await prisma.$transaction(async (tx) => {
      const currentCommand = await tx.webhookExecutionClaim.findUnique({
        where: { id: command.id },
      });
      const currentLedger = await tx.maxActionLedgerEntry.findUnique({
        where: { jobId: journal.ledgerKey },
      });
      if (
        !currentCommand ||
        currentCommand.status !== 'COMPLETED' ||
        currentCommand.leaseToken ||
        currentCommand.leaseExpiresAt ||
        !readJournal(event, { ...execution, commandResult: journal }, currentCommand) ||
        !isCompletedSend(currentLedger, journal, chatId)
      )
        throw new WebhookPreparationDeferredError('Command notice completion proof changed', 1_000);
      const finishedAt = new Date();
      const finished = {
        kind: 'EXECUTION_FINISHED',
        authorityVersion: MULTIBOT_EXECUTION_AUTHORITY_VERSION,
        webhookEventId: event.id,
        semanticKey,
        executionBotId: journal.executionBotId,
        businessStartedAt: journal.businessStartedAt,
        finishedAt: finishedAt.toISOString(),
      };
      const settledClaim = await tx.webhookExecutionClaim.updateMany({
        where: { ...owned(), leaseExpiresAt: { gt: new Date() } },
        data: {
          status: 'COMPLETED',
          completedAt: finishedAt,
          commandResult: finished,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      if (settledClaim.count !== 1)
        throw new WebhookPreparationDeferredError('Command notice recovery lease changed', 1_000);
      const settledReceipt = await tx.webhookEvent.updateMany({
        where: {
          id: event.id,
          normalizedPayload: { equals: event.normalizedPayload as Prisma.InputJsonValue },
          status: event.status,
          errorMessage: event.errorMessage,
          timeoutQuarantineExpiresAt: null,
        },
        data: {
          status: 'PROCESSED',
          processedAt: finishedAt,
          errorMessage: null,
          nextEnqueueAt: null,
          queueName: null,
        },
      });
      if (settledReceipt.count !== 1)
        throw new WebhookPreparationDeferredError('Command notice recovery receipt changed', 1_000);
    });
    return true;
  } catch (error) {
    const refreshed = await recordGroupCommandNoticeRecovery(
      prisma,
      {
        webhookEvent: event,
        update,
        activeBotId: execution.executionBotId,
        businessLeaseToken: leaseToken,
      },
      error,
    );
    if (refreshed) journal = refreshed;
    throw error;
  } finally {
    if (permit) await authority.release(permit);
    await prisma.webhookExecutionClaim.updateMany({
      where: owned(),
      data: { leaseToken: null, leaseExpiresAt: null },
    });
  }
}
