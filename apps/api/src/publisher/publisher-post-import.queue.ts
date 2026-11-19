import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { createHash } from 'node:crypto';

export const PUBLISHER_POST_IMPORT_QUEUE = 'publisher-post-import';
export const PUBLISHER_POST_IMPORT_PROCESS_JOB_BUCKET_MS = 2 * 60_000;

export function buildPublisherPostImportProcessJobId(sessionId: string, requestedAt: Date): string {
  return `publisher-post-import-process-${sessionId}-${Math.floor(
    requestedAt.getTime() / PUBLISHER_POST_IMPORT_PROCESS_JOB_BUCKET_MS,
  )}`;
}

export function buildPublisherPostImportNotificationJobId(
  sessionId: string,
  notification: PublisherPostImportNotification,
  dedupeKey: string,
): string {
  const digest = createHash('sha256').update(dedupeKey).digest('hex').slice(0, 24);
  return `publisher-post-import-notify-${sessionId}-${notification}-${digest}`;
}

export type PublisherPostImportNotification =
  | 'prompt'
  | 'need_forward'
  | 'collecting'
  | 'collected'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'canceled';

export type PublisherPostImportJob =
  | {
      version: 1;
      kind: 'process';
      sessionId: string;
      requestedAt: string;
    }
  | {
      version: 1;
      kind: 'notify';
      sessionId: string;
      notification: PublisherPostImportNotification;
      privateChatId?: string;
      callbackId?: string;
      requestedAt: string;
    };

@Injectable()
export class PublisherPostImportQueueService {
  constructor(
    @InjectQueue(PUBLISHER_POST_IMPORT_QUEUE)
    private readonly queue: Queue<PublisherPostImportJob>,
  ) {}

  async enqueueProcess(sessionId: string, requestedAt = new Date()): Promise<void> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return;
    }
    await this.queue.add(
      'process',
      {
        version: 1,
        kind: 'process',
        sessionId: normalizedSessionId,
        requestedAt: requestedAt.toISOString(),
      },
      {
        jobId: buildPublisherPostImportProcessJobId(normalizedSessionId, requestedAt),
        priority: 2,
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  async enqueueNotification(params: {
    sessionId: string;
    notification: PublisherPostImportNotification;
    privateChatId?: string | null;
    callbackId?: string | null;
    dedupeKey?: string;
    requestedAt?: Date;
  }): Promise<void> {
    const sessionId = params.sessionId.trim();
    if (!sessionId) {
      return;
    }
    const requestedAt = params.requestedAt ?? new Date();
    const dedupeKey = params.dedupeKey?.trim() || String(requestedAt.getTime());
    await this.queue.add(
      'notify',
      {
        version: 1,
        kind: 'notify',
        sessionId,
        notification: params.notification,
        ...(params.privateChatId?.trim() ? { privateChatId: params.privateChatId.trim() } : {}),
        ...(params.callbackId?.trim() ? { callbackId: params.callbackId.trim() } : {}),
        requestedAt: requestedAt.toISOString(),
      },
      {
        jobId: buildPublisherPostImportNotificationJobId(sessionId, params.notification, dedupeKey),
        priority: 1,
        attempts: 4,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { age: 60 * 60, count: 5_000 },
        removeOnFail: { age: 24 * 60 * 60, count: 5_000 },
      },
    );
  }
}
