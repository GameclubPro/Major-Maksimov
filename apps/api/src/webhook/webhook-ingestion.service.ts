import {
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { PublisherWebhookCredentialService } from '../publisher/publisher-webhook-credential.service';
import { WebhookIngressMetricsService } from '../system/webhook-ingress-metrics.service';
import { WebhookSubscriptionStatusService } from '../system/webhook-subscription-status.service';
import {
  DEFAULT_MAX_WEBHOOK_ACK_DEADLINE_MS,
  readMaxWebhookAdmittedBotId,
  type MaxWebhookEarlyAdmissionDecision,
} from './webhook-http-route-limit';
import { WebhookParser } from './webhook.parser';
import { WebhookRateLimitService } from './webhook-rate-limit.service';
import { WebhookService } from './webhook.service';

const DEFAULT_WEBHOOK_RECEIPT_MAX_IN_FLIGHT = 64;

class WebhookAckDeadlineExceededError extends Error {}
class WebhookReceiptCapacityExceededError extends Error {}

export type WebhookIngestionParams = {
  botId: string;
  secretPath: string;
};

export type WebhookIngestionRequest = Pick<FastifyRequest, 'headers' | 'ip'>;

export type WebhookIngestionResult = {
  ok: true;
  duplicate: boolean;
  acceptedAt: string;
};

@Injectable()
export class WebhookIngestionService {
  private readonly logger = new Logger(WebhookIngestionService.name);
  private readonly ackDeadlineMs: number;
  private readonly receiptMaxInFlight: number;
  private receiptInFlight = 0;

  constructor(
    private readonly botRegistry: MaxBotRegistryService,
    private readonly parser: WebhookParser,
    private readonly webhookService: WebhookService,
    private readonly webhookRateLimitService: WebhookRateLimitService,
    private readonly webhookSubscriptionStatusService: WebhookSubscriptionStatusService,
    configService: ConfigService,
    @Optional() private readonly webhookIngressMetricsService?: WebhookIngressMetricsService,
    @Optional()
    private readonly publisherWebhookCredentials?: PublisherWebhookCredentialService,
  ) {
    this.ackDeadlineMs = this.readPositiveInt(
      configService.get('WEBHOOK_ACK_DEADLINE_MS'),
      DEFAULT_MAX_WEBHOOK_ACK_DEADLINE_MS,
    );
    this.receiptMaxInFlight = this.readPositiveInt(
      configService.get('WEBHOOK_RECEIPT_MAX_IN_FLIGHT'),
      DEFAULT_WEBHOOK_RECEIPT_MAX_IN_FLIGHT,
    );
  }

  async ingest(
    params: WebhookIngestionParams,
    payload: Record<string, unknown>,
    request: WebhookIngestionRequest,
    requestAckDeadlineAtMs?: number | null,
  ): Promise<WebhookIngestionResult> {
    const ackDeadlineAtMs = this.resolveAckDeadlineAtMs(requestAckDeadlineAtMs);
    const bot = this.resolveAuthenticatedBot(params, request);
    if (!bot) {
      throw new ForbiddenException('Invalid webhook bot signature');
    }

    const ip = request.ip;
    if (readMaxWebhookAdmittedBotId(request) !== bot.id) {
      await this.ensureIngressAdmission(bot.id, ip, ackDeadlineAtMs);
    }

    const update = this.parser.parse(payload, { botId: bot.id });
    const receiptPersistenceStartedAtMs = Date.now();
    let result: Awaited<ReturnType<WebhookService['storeReceipt']>>;
    try {
      result = await this.storeReceiptWithinAckDeadline(update, ip, bot.id, ackDeadlineAtMs);
    } catch (error: unknown) {
      const capacityExceeded = error instanceof WebhookReceiptCapacityExceededError;
      this.recordReceiptPersistenceAsync({
        botId: bot.id,
        outcome: capacityExceeded ? 'rejected' : 'failed',
        latencyMs: capacityExceeded ? 0 : Date.now() - receiptPersistenceStartedAtMs,
      });
      const context = {
        botId: bot.id,
        receiptInFlight: this.receiptInFlight,
        receiptMaxInFlight: this.receiptMaxInFlight,
        err: error instanceof Error ? error.message : String(error),
      };
      if (capacityExceeded) {
        this.logger.warn(context, 'Webhook receipt capacity exhausted; requesting MAX redelivery');
      } else {
        this.logger.error(context, 'Failed to persist webhook receipt; requesting MAX redelivery');
      }
      throw new ServiceUnavailableException('Webhook receipt storage unavailable');
    }
    this.recordReceiptPersistenceAsync({
      botId: bot.id,
      outcome: 'persisted',
      latencyMs: Date.now() - receiptPersistenceStartedAtMs,
    });
    this.webhookSubscriptionStatusService.recordIncomingWebhook(bot.id);

    if (result.duplicate) {
      try {
        await this.runReceiptWorkWithinAckDeadline(
          () => this.webhookService.repairDuplicateReceiptReadModels(update),
          ackDeadlineAtMs,
          {
            botId: bot.id,
            updateId: update.updateId,
            label: 'duplicate read-model repair',
          },
        );
      } catch (error: unknown) {
        this.logger.warn(
          {
            botId: bot.id,
            updateId: update.updateId,
            type: update.type,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to repair duplicate webhook read models; requesting MAX redelivery',
        );
        throw new ServiceUnavailableException('Webhook duplicate repair unavailable');
      }
    }

    return {
      ok: true,
      duplicate: result.duplicate,
      acceptedAt: new Date().toISOString(),
    };
  }

  async admitBeforeBody(
    params: WebhookIngestionParams,
    request: WebhookIngestionRequest,
    requestAckDeadlineAtMs?: number | null,
  ): Promise<MaxWebhookEarlyAdmissionDecision> {
    const bot = this.resolveAuthenticatedBot(params, request);
    if (!bot) {
      return {
        accepted: false,
        botId: null,
        outcome: 'authentication_rejected',
        statusCode: 403,
      };
    }

    try {
      await this.ensureIngressAdmission(
        bot.id,
        request.ip,
        this.resolveAckDeadlineAtMs(requestAckDeadlineAtMs),
      );
      return { accepted: true, botId: bot.id };
    } catch {
      return {
        accepted: false,
        botId: bot.id,
        outcome: 'admission_rejected',
        statusCode: 503,
      };
    }
  }

  private async storeReceiptWithinAckDeadline(
    update: Parameters<WebhookService['storeReceipt']>[0],
    sourceIp: string,
    botId: string,
    deadlineAtMs: number,
  ): Promise<Awaited<ReturnType<WebhookService['storeReceipt']>>> {
    return this.runReceiptWorkWithinAckDeadline(
      () => this.webhookService.storeReceipt(update, sourceIp),
      deadlineAtMs,
      {
        botId,
        updateId: update.updateId,
        label: 'receipt persistence',
      },
      (result) => ({ duplicate: result.duplicate }),
    );
  }

  private async runReceiptWorkWithinAckDeadline<T>(
    operation: () => Promise<T>,
    deadlineAtMs: number,
    context: { botId: string; updateId: string; label: string },
    readSuccessContext: (result: T) => Record<string, unknown> = () => ({}),
  ): Promise<T> {
    const remainingMs = Math.max(0, deadlineAtMs - Date.now());
    if (remainingMs === 0) {
      throw new WebhookAckDeadlineExceededError(
        `Webhook ACK deadline exceeded before ${context.label}`,
      );
    }
    if (this.receiptInFlight >= this.receiptMaxInFlight) {
      throw new WebhookReceiptCapacityExceededError(
        `Webhook receipt work already has ${this.receiptInFlight} in-flight operations before ${context.label}`,
      );
    }

    this.receiptInFlight += 1;
    const startedAtMs = Date.now();
    const release = () => {
      this.receiptInFlight = Math.max(0, this.receiptInFlight - 1);
    };
    let operationPromise: Promise<T>;
    try {
      const startOperation = () => {
        // FLAG: Observing low-priority exclusion never renews the original ACK
        // deadline or starts SQL work after admission has already expired.
        if (Date.now() >= deadlineAtMs)
          throw new WebhookAckDeadlineExceededError(
            `Webhook ACK deadline exceeded before ${context.label}`,
          );
        return operation();
      };
      operationPromise = this.webhookIngressMetricsService
        ? this.webhookIngressMetricsService.observeReceiptWork(startOperation)
        : startOperation();
    } catch (error: unknown) {
      release();
      throw error;
    }
    void operationPromise.then(release, release);

    try {
      return await this.withAckDeadline(() => operationPromise, deadlineAtMs, context.label);
    } catch (error: unknown) {
      if (error instanceof WebhookAckDeadlineExceededError) {
        this.observeLateReceiptWorkCompletion(
          operationPromise,
          {
            ...context,
            startedAtMs,
          },
          readSuccessContext,
        );
      }
      throw error;
    }
  }

  private readWebhookHeaderSecret(headers: WebhookIngestionRequest['headers']): string {
    return String(headers['x-max-bot-api-secret'] ?? headers['x-max-secret'] ?? '');
  }

  private resolveAuthenticatedBot(
    params: WebhookIngestionParams,
    request: WebhookIngestionRequest,
  ) {
    const credentials = {
      botId: params.botId,
      secretPath: params.secretPath,
      providedHeaderSecret: this.readWebhookHeaderSecret(request.headers),
    };
    return (
      this.botRegistry.resolveWebhookBot(credentials) ??
      this.publisherWebhookCredentials?.resolveWebhookBot(credentials) ??
      null
    );
  }

  private async ensureIngressAdmission(
    botId: string,
    ip: string,
    ackDeadlineAtMs: number,
  ): Promise<void> {
    let allowed: boolean;
    try {
      allowed = await this.withAckDeadline(
        () => this.webhookRateLimitService.isAllowed(ip),
        ackDeadlineAtMs,
        'ingress admission',
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          botId,
          ip,
          err: error instanceof Error ? error.message : String(error),
        },
        'Webhook ingress admission unavailable before ACK deadline; requesting MAX redelivery',
      );
      throw new ServiceUnavailableException('Webhook ingress capacity unavailable');
    }
    if (allowed) {
      return;
    }

    this.logger.warn(
      {
        botId,
        ip,
      },
      'Webhook ingress admission budget exceeded; requesting MAX redelivery',
    );
    throw new ServiceUnavailableException('Webhook ingress capacity exceeded');
  }

  private recordReceiptPersistenceAsync(
    metric: Parameters<WebhookIngressMetricsService['recordReceiptPersistence']>[0],
  ): void {
    const metricsService = this.webhookIngressMetricsService;
    if (!metricsService) {
      return;
    }
    setImmediate(() => {
      void metricsService.recordReceiptPersistence(metric).catch(() => undefined);
    });
  }

  private async withAckDeadline<T>(
    operation: () => Promise<T>,
    deadlineAtMs: number,
    label: string,
  ): Promise<T> {
    const remainingMs = Math.max(0, deadlineAtMs - Date.now());
    if (remainingMs === 0) {
      throw new WebhookAckDeadlineExceededError(`Webhook ACK deadline exceeded before ${label}`);
    }

    let timeout: NodeJS.Timeout | undefined;
    try {
      const operationPromise = operation();
      return await Promise.race([
        operationPromise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(
              new WebhookAckDeadlineExceededError(`Webhook ACK deadline exceeded during ${label}`),
            );
          }, remainingMs);
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private observeLateReceiptWorkCompletion<T>(
    operation: Promise<T>,
    context: { botId: string; updateId: string; label: string; startedAtMs: number },
    readSuccessContext: (result: T) => Record<string, unknown>,
  ): void {
    void operation.then(
      (result) => {
        this.logger.warn(
          {
            botId: context.botId,
            updateId: context.updateId,
            ...readSuccessContext(result),
            latencyMs: Date.now() - context.startedAtMs,
            receiptInFlight: this.receiptInFlight,
          },
          `Webhook ${context.label} completed after its ACK deadline`,
        );
      },
      (error: unknown) => {
        this.logger.warn(
          {
            botId: context.botId,
            updateId: context.updateId,
            latencyMs: Date.now() - context.startedAtMs,
            receiptInFlight: this.receiptInFlight,
            err: error instanceof Error ? error.message : String(error),
          },
          `Webhook ${context.label} failed after its ACK deadline`,
        );
      },
    );
  }

  private resolveAckDeadlineAtMs(value: number | null | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.trunc(value)
      : Date.now() + this.ackDeadlineMs;
  }

  private readPositiveInt(value: unknown, fallback: number): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.trunc(parsed)) : fallback;
  }
}
