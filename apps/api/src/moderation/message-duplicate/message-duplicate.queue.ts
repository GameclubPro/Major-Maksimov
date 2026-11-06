import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import {
  PhotoDuplicateOrderingStore,
  PhotoDuplicateOrderingUnavailableError,
  DUPLICATE_JOB_MAX_LIFETIME_MS,
} from '../photo-duplicate/photo-duplicate-ordering.store';
import { digestDuplicateContent } from './message-duplicate-content';
import { MessageDuplicateAdmissionService } from './message-duplicate-admission.service';

export const MESSAGE_DUPLICATE_QUEUE = 'message-duplicates';
export const MESSAGE_DUPLICATE_JOB_VERSION = 2;
export type MessageDuplicateJob = {
  version: 2;
  webhookEventId: string;
  chatId: string;
  messageId: string;
  eventTimestampMs: number;
  controlRevision: number;
  policyRevision: number;
  settingsDigest: string;
  sourceCreatedAt: string;
  createdAt: string;
  deadlineAtMs: number;
  actionEligible: boolean;
  cleanupOnly?: 'completed' | 'terminated';
  comparison?: 'TEXT' | 'IMAGE';
  idempotencyKey: string;
};

@Injectable()
export class MessageDuplicateOrderingStore extends PhotoDuplicateOrderingStore {
  protected override readonly namespace = 'message-duplicate:ordering:v2';
  constructor(config: ConfigService) {
    super(config);
  }
}

export function buildMessageDuplicateJobId(
  chatId: string,
  messageId: string,
  eventTimestampMs: number,
  comparison?: 'TEXT' | 'IMAGE',
): string {
  return `message-duplicate__${digestDuplicateContent([chatId, messageId, eventTimestampMs, MESSAGE_DUPLICATE_JOB_VERSION, ...(comparison === 'IMAGE' ? ['image-v1'] : [])])}`;
}

@Injectable()
export class MessageDuplicateEnqueueService {
  constructor(
    @Optional()
    @InjectQueue(MESSAGE_DUPLICATE_QUEUE)
    private readonly queue?: Queue<MessageDuplicateJob>,
    @Optional() private readonly ordering?: MessageDuplicateOrderingStore,
    @Optional() private readonly admission?: MessageDuplicateAdmissionService,
  ) {}

  async enqueue(
    input: Omit<
      MessageDuplicateJob,
      'version' | 'createdAt' | 'idempotencyKey' | 'deadlineAtMs' | 'cleanupOnly'
    > & { deadlineAtMs?: number },
  ): Promise<void> {
    if (!this.queue || !this.ordering || !this.admission)
      throw new Error('Message duplicate queue unavailable');
    const id = buildMessageDuplicateJobId(
      input.chatId,
      input.messageId,
      input.eventTimestampMs,
      input.comparison,
    );
    const identity = {
      jobId: id,
      chatId: input.chatId,
      sourceCreatedAt: input.sourceCreatedAt,
      deadlineAtMs: Math.min(
        input.deadlineAtMs ?? Number.MAX_SAFE_INTEGER,
        input.eventTimestampMs + DUPLICATE_JOB_MAX_LIFETIME_MS,
        Date.now() + DUPLICATE_JOB_MAX_LIFETIME_MS,
      ),
    };
    const admission = await this.admission.register({
      jobId: id,
      chatId: input.chatId,
      messageId: input.messageId,
    });
    const existingJob = await this.queue.getJob(id);
    const registrationKind = existingJob ? 'retry' : admission.registration;
    if (
      registrationKind === 'retry' &&
      !existingJob &&
      input.actionEligible &&
      // FLAG: An expired deadline must reach Redis terminal settlement; its false
      // permit is expected and cannot become usable after waiting for initial admission.
      identity.deadlineAtMs > Date.now() &&
      Date.now() - admission.admittedAtMs < 5000 &&
      !(await this.ordering.readActionEligibility(identity))
    )
      throw new PhotoDuplicateOrderingUnavailableError(
        'Message duplicate initial admission is incomplete',
      );
    try {
      const registration = await this.ordering.announce(
        identity,
        input.actionEligible === true,
        registrationKind,
      );
      if (registration.kind === 'completed' || registration.kind === 'expired') return;
      if (registration.kind === 'unavailable') throw new PhotoDuplicateOrderingUnavailableError();
      await this.queue.add(
        'message-duplicate-analysis',
        {
          ...input,
          version: MESSAGE_DUPLICATE_JOB_VERSION,
          createdAt: new Date(registration.admittedAtMs).toISOString(),
          deadlineAtMs: registration.deadlineAtMs,
          idempotencyKey: id,
          actionEligible: registration.actionEligible,
        },
        {
          jobId: id,
          delay: 5000,
          attempts: 5,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { age: 86400, count: 25_000 },
          removeOnFail: { age: 86400, count: 5000 },
        },
      );
    } catch (error) {
      // FLAG: Retry the same eligibility after a lost response. The absorbing Redis latch preserves
      // any concurrent false; a transport failure alone must not permanently suppress enforcement.
      await this.ordering
        .announce(identity, input.actionEligible === true, 'retry')
        .catch(() => undefined);
      throw error;
    }
  }
}
