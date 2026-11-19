import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError, type Job } from 'bullmq';
import { isPrivateDirectChatId } from '../common/chat-id.util';
import { normalizeMaxUserDisplayName } from '../common/max-user-display-name.util';
import { buildUserAgreementStartNotice } from '../common/user-agreement-notice';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { withMaxFinalAuthorityCheckpoint } from '../max/max-action-pre-dispatch-guard';
import { MaxClientService, MAX_API_SOURCE_TAGS } from '../max/max-client.service';
import { SUPPORT_CHAT_URL } from '../moderation/private-control.constants';
import { renderPrivateProfileMentionMessage } from '../moderation/private-control-profile-mention-handoff';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import {
  assertPublisherDispatchAllowedOrDelay,
  assertPublisherRuntimeEnabledOrDelay,
} from './publisher-dispatch-job-guard';
import { PublisherCommentProfileService } from './publisher-comment-profile.service';
import { PublisherDispatchHealthService } from './publisher-dispatch-health.service';
import { assertPublisherIdentityOrDelay } from './publisher-identity-attestation-job-guard';
import { PublisherIdentityAttestationService } from './publisher-identity-attestation.service';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';
import {
  isFreshPublisherStart,
  PUBLISHER_START_QUEUE,
  PublisherStartQueueService,
  type PublisherCommentProfileStartJob,
  type PublisherStartJob,
} from './publisher-start.queue';

const PUBLISHER_HOME_START_PARAM = `mr-${Buffer.from(
  JSON.stringify({ v: 1, k: 'route', r: '/' }),
  'utf8',
).toString('base64url')}`;

export function buildPublisherStartText(appBaseUrl?: string | null): string {
  return [
    'Привет! Я Публик, помощник для публикаций в MAX от создателей [Майора Максимова](https://max.ru/id613070470872_9_bot).',
    'Помогаю создавать посты для чатов и каналов, публиковать их сразу или по расписанию и настраивать автопостинг из VK.',
    'Чтобы подключить чат или канал, добавьте меня администратором с правом публикации и перешлите сюда любое сообщение оттуда: текст, фото, видео или файл. Подключить сообщество может его владелец или администратор.',
    'Управление публикациями и подключёнными чатами и каналами доступно в мини-приложении.',
    buildUserAgreementStartNotice(appBaseUrl),
  ].join('\n\n');
}

@Processor(PUBLISHER_START_QUEUE, { concurrency: 2 })
export class PublisherStartProcessor extends WorkerHost {
  constructor(
    private readonly maxClient: MaxClientService,
    private readonly botRegistry: MaxBotRegistryService,
    private readonly botLinks: MaxBotLinkService,
    private readonly config: ConfigService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    private readonly startQueue: PublisherStartQueueService,
    @Optional() private readonly commentProfile?: PublisherCommentProfileService,
  ) {
    super();
  }

  async process(job: Job<PublisherStartJob>, token?: string): Promise<void> {
    if (!roleRunsPublisher(getAppRole()) || process.env.APP_SERVICE_NAME !== 'api-publisher') {
      throw new Error('Publisher greeting claimed outside api-publisher');
    }
    const { publisherBotId, privateChatId, requestedAt } = job.data;
    if (job.data.version === 4) {
      await this.sendCommentAuthorProfile(job as Job<PublisherCommentProfileStartJob>, token);
      return;
    }
    if (
      // FLAG: Legacy jobs can be restored from before their Redis-only dispatch fence.
      // Only v2/v3 producers belong to the durable-ledger delivery protocol.
      (job.data.version !== 2 && job.data.version !== 3) ||
      !job.id ||
      publisherBotId !== this.botRegistry.getPublisherBotDescriptor().id ||
      !isPrivateDirectChatId(privateChatId)
    )
      throw new UnrecoverableError('Invalid publisher greeting job');
    if (!isFreshPublisherStart(requestedAt)) return;
    if (job.data.dispatchStarted) return;
    await assertPublisherRuntimeEnabledOrDelay(this.runtimeBoundary, job, token);
    await assertPublisherIdentityOrDelay(this.identityAttestation, job, token);
    await assertPublisherDispatchAllowedOrDelay(this.dispatchHealth, job, token);
    const miniappUrl = this.botLinks.buildMiniappStartUrlSync(
      PUBLISHER_HOME_START_PARAM,
      publisherBotId,
    );
    let dispatchClaimed = false;
    try {
      await this.maxClient.sendMessage(
        privateChatId,
        buildPublisherStartText(this.config.get<string>('APP_BASE_URL')),
        {
          textFormat: 'markdown',
          buttons: [
            ...(miniappUrl
              ? [[{ type: 'link' as const, text: 'Открыть Публик', url: miniappUrl }]]
              : []),
            [{ type: 'link', text: 'Поддержка', url: SUPPORT_CHAT_URL }],
          ],
        },
        {
          // FLAG: Use the existing PostgreSQL send ledger before any MAX attempt. Keep the
          // original job identity across retries, worker crashes and Redis snapshot restores.
          immediate: true,
          idempotencyKey: job.id,
          beforeImmediateSendMutation: async () => {
            // FLAG: Persist before POST /messages. A stalled or ambiguous send must never replay.
            if (job.data.dispatchStarted)
              throw new UnrecoverableError('Publisher greeting already attempted');
            if (!isFreshPublisherStart(requestedAt))
              throw new UnrecoverableError('Publisher greeting expired');
            if (
              job.data.version === 3 &&
              !(await this.startQueue.claimDurableDispatch(job.id!, job.data))
            )
              throw new UnrecoverableError(
                'Publisher greeting intent already attempted or expired',
              );
            // FLAG: A crash from this point leaves ATTEMPTED, never a recoverable pending send.
            dispatchClaimed = job.data.version === 3;
            if (!(await this.startQueue.claimDispatch(job.id!)))
              throw new UnrecoverableError('Publisher greeting dispatch already claimed');
            dispatchClaimed = true;
            await job.updateData({ ...job.data, dispatchStarted: true });
          },
          botId: publisherBotId,
          trafficClass: 'interactive',
          actionHealthLane: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.PUBLISHER_START,
          timeoutMs: 5_000,
          ignoreFailureMetricStatuses: [403, 404],
        },
      );
      if (job.data.version === 3) await this.startQueue.completeIntent(job.id, 'SENT');
    } catch (error: unknown) {
      if (job.data.version === 3 && dispatchClaimed)
        await this.startQueue.completeIntent(job.id, 'UNKNOWN');
      if (dispatchClaimed || job.data.dispatchStarted)
        throw new UnrecoverableError(
          'Publisher greeting dispatch claimed; automatic retry disabled',
        );
      throw error;
    }
  }

  private async sendCommentAuthorProfile(
    job: Job<PublisherCommentProfileStartJob>,
    token?: string,
  ): Promise<void> {
    const { publisherBotId, privateChatId } = job.data;
    if (
      !job.id ||
      job.name !== 'comment-author-profile' ||
      publisherBotId !== this.botRegistry.getPublisherBotDescriptor().id ||
      !isPrivateDirectChatId(privateChatId)
    ) {
      throw new UnrecoverableError('Invalid Publisher comment profile job');
    }
    const handoff = this.commentProfile?.verifyQueuedStart(job.data, job.id);
    if (!handoff || job.data.dispatchStarted) return;
    const { commentId, expiresAtMs } = handoff;
    await assertPublisherRuntimeEnabledOrDelay(this.runtimeBoundary, job, token);
    await assertPublisherIdentityOrDelay(this.identityAttestation, job, token);
    await assertPublisherDispatchAllowedOrDelay(this.dispatchHealth, job, token);

    const comment = await this.startQueue.findProfileComment(commentId);
    if (!comment || !/^[1-9][0-9]{0,19}$/u.test(comment.actorUserId)) {
      return;
    }
    const displayName =
      comment.payload && typeof comment.payload === 'object' && !Array.isArray(comment.payload)
        ? comment.payload.authorDisplayName
        : null;
    const message = renderPrivateProfileMentionMessage({
      displayName: normalizeMaxUserDisplayName(displayName, comment.actorUserId) ?? 'Пользователь',
      userId: comment.actorUserId,
    });

    let claimed = false;
    try {
      await this.maxClient.sendMessage(privateChatId, message.text, message.options, {
        immediate: true,
        idempotencyKey: job.id,
        beforeImmediateSendMutation: withMaxFinalAuthorityCheckpoint(async (checkpoint) => {
          await checkpoint?.();
          if (expiresAtMs <= Date.now() || job.data.dispatchStarted) {
            throw new UnrecoverableError('Publisher comment profile request expired or attempted');
          }
          // FLAG: The Publisher queue fence and durable MAX SEND ledger keep the same identity
          // for restored jobs. Once dispatch is claimed, an uncertain SEND is never retried.
          if (!(await this.startQueue.claimDispatch(job.id!))) {
            throw new UnrecoverableError('Publisher comment profile dispatch already claimed');
          }
          claimed = true;
          await job.updateData({ ...job.data, dispatchStarted: true });
        }),
        botId: publisherBotId,
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.PUBLISHER_START,
        timeoutMs: 5_000,
        ignoreFailureMetricStatuses: [403, 404],
      });
    } catch (error: unknown) {
      if (claimed || job.data.dispatchStarted) {
        throw new UnrecoverableError(
          'Publisher comment profile dispatch claimed; automatic retry disabled',
        );
      }
      throw error;
    }
  }
}
