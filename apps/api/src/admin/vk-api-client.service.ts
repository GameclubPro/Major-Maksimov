import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { formatVkParsingError, readVkRetryAtMs, VkApiRequestError } from './vk-parsing-errors';
import {
  type VkApiAdmissionOptions,
  VkParsingRateLimitService,
} from './vk-parsing-rate-limit.service';

const VK_API_RATE_LIMIT_ERROR_CODE = 6;
const VK_API_RETRYABLE_ERROR_CODES = new Set([VK_API_RATE_LIMIT_ERROR_CODE, 9, 10, 29]);
const VK_API_TERMINAL_ERROR_CODES = new Set([5, 14, 15, 18, 19, 30, 100, 203, 210]);
const VK_API_REQUEST_BUDGET_MS = 20_000;
const HTTP_MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];
const HTTP_WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

@Injectable()
export class VkApiClientService {
  private readonly vkApiBaseUrl: string;
  private readonly vkApiVersion: string;
  private readonly vkApiTimeoutMs: number;
  private readonly vkApiMaxAttempts: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly vkRateLimitService: VkParsingRateLimitService,
  ) {
    this.vkApiBaseUrl = this.normalizeBaseUrl(
      configService.get<string>('VK_API_BASE_URL') ?? 'https://api.vk.ru',
    );
    this.vkApiVersion = configService.get<string>('VK_API_VERSION') ?? '5.199';
    this.vkApiTimeoutMs = configService.get<number>('VK_API_TIMEOUT_MS') ?? 10_000;
    this.vkApiMaxAttempts = configService.get<number>('VK_API_MAX_ATTEMPTS') ?? 3;
  }

  async request(method: string, params: Record<string, string>): Promise<unknown> {
    const token = this.configService.get<string>('VK_SERVICE_TOKEN')?.trim();
    if (!token) {
      throw new ServiceUnavailableException('VK_SERVICE_TOKEN не настроен.');
    }

    const deadlineAt = Date.now() + VK_API_REQUEST_BUDGET_MS;
    const admission: VkApiAdmissionOptions = {
      credentialScope: createHash('sha256')
        .update(new URL(this.vkApiBaseUrl).origin)
        .update('\0')
        .update(token)
        .digest('hex'),
      deadlineAtMs: deadlineAt,
    };
    for (let attempt = 1; attempt <= this.vkApiMaxAttempts; attempt += 1) {
      try {
        if (Date.now() >= deadlineAt) {
          throw new VkApiRequestError('VK API не ответил вовремя.', 'timeout', true);
        }
        await this.vkRateLimitService.reserveVkApiSlot(method, admission);
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) {
          throw new VkApiRequestError('VK API не ответил вовремя.', 'timeout', true);
        }
        const payload = await this.fetchVkApi(method, params, token, admission);
        const record = this.asRecord(payload);

        const error = this.asRecord(record?.error);
        if (error) {
          const code = this.readNumber(error.error_code);
          const message =
            code === 14
              ? 'VK требует капчу или токен не подходит для запроса.'
              : this.readString(error.error_msg) || 'VK API отклонил запрос.';
          throw new VkApiRequestError(
            code ? `VK API: ${message} (${code})` : `VK API: ${message}`,
            code ? `vk_${code}` : 'vk_unknown',
            code ? this.isRetryableVkApiErrorCode(code) : false,
          );
        }

        if (!record || record.response === undefined || record.response === null) {
          throw new VkApiRequestError('VK API вернул неполный ответ.', 'invalid_response', true);
        }
        await this.vkRateLimitService
          .recordVkApiOutcome({ method, outcome: 'success' })
          .catch(() => undefined);
        return record.response;
      } catch (error) {
        const classified = this.classifyVkRequestError(error);
        await this.vkRateLimitService
          .recordVkApiOutcome({
            method,
            outcome: 'error',
            code: classified.code,
          })
          .catch(() => undefined);
        const retryAtMs = readVkRetryAtMs(classified.error.retryAtMs);
        const retryDelayMs = Math.max(
          this.resolveVkRequestRetryDelayMs(attempt, classified.code),
          retryAtMs === undefined ? 0 : retryAtMs - Date.now(),
        );
        if (
          !classified.retryable ||
          classified.code === 'provider_cooldown' ||
          attempt >= this.vkApiMaxAttempts ||
          Date.now() + retryDelayMs >= deadlineAt
        ) {
          throw classified.error;
        }

        await this.sleep(retryDelayMs);
      }
    }

    throw new VkApiRequestError('VK API временно недоступен.', 'retry_exhausted', true);
  }

  private async fetchVkApi(
    method: string,
    params: Record<string, string>,
    token: string,
    admission: VkApiAdmissionOptions,
  ): Promise<unknown> {
    const search = new URLSearchParams({
      ...params,
      v: this.vkApiVersion,
    });
    const timeoutMs = Math.min(this.vkApiTimeoutMs, admission.deadlineAtMs - Date.now());
    if (timeoutMs <= 0) {
      throw new VkApiRequestError('VK API не ответил вовремя.', 'timeout', true);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let httpError: VkApiRequestError | undefined;
    try {
      const response = await fetch(`${this.vkApiBaseUrl}/method/${method}?${search.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const receivedAtMs = Date.now();
        const retryable =
          response.status === 408 || response.status === 429 || response.status >= 500;
        const retryAtMs = retryable
          ? this.readRetryAfter(response.headers?.get('retry-after'), receivedAtMs)
          : undefined;
        // FLAG: Capture provider evidence before asynchronous bookkeeping/cleanup.
        // A late abort cannot erase an observed HTTP status or its retry deadline.
        httpError = new VkApiRequestError(
          `VK API вернул статус ${response.status}.`,
          `http_${response.status}`,
          retryable,
          retryAtMs,
        );
        if (retryAtMs !== undefined) {
          // FLAG: Only actual HTTP responses publish provider cooldown. The limiter
          // retains its local deadline before Redis; a failed ACK is not peer coverage.
          await this.vkRateLimitService
            .publishVkApiCooldown(admission.credentialScope, retryAtMs)
            .catch(() => undefined);
        }
        await response.body?.cancel().catch(() => undefined);
        throw httpError;
      }
      return await this.readVkResponsePayload(response);
    } catch (error) {
      if (httpError) throw httpError;
      if (controller.signal.aborted) {
        throw new VkApiRequestError('VK API не ответил вовремя.', 'timeout', true);
      }
      if (error instanceof VkApiRequestError) throw error;
      const aborted =
        error instanceof Error &&
        (error.name === 'AbortError' || /abort|timeout/iu.test(error.message));
      throw new VkApiRequestError(
        aborted ? 'VK API не ответил вовремя.' : 'VK API временно недоступен.',
        aborted ? 'timeout' : 'network',
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private readRetryAfter(
    value: string | null | undefined,
    receivedAtMs: number,
  ): number | undefined {
    const header = value?.trim();
    if (!header) return undefined;
    if (/^\d+$/u.test(header)) {
      const retryAtMs = readVkRetryAtMs(receivedAtMs + Number(header) * 1_000);
      return retryAtMs !== undefined && retryAtMs > receivedAtMs ? retryAtMs : undefined;
    }

    const modern =
      /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/iu.exec(
        header,
      );
    const obsolete =
      /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/iu.exec(
        header,
      );
    const asctime =
      /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( \d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/iu.exec(
        header,
      );
    const parts =
      modern ??
      obsolete ??
      (asctime && [
        asctime[0],
        asctime[1],
        asctime[3],
        asctime[2],
        asctime[7],
        asctime[4],
        asctime[5],
        asctime[6],
      ]);
    if (!parts) return undefined;
    const weekday = HTTP_WEEKDAYS.indexOf(parts[1]!.slice(0, 3).toLowerCase());
    const day = Number(parts[2]);
    const month = HTTP_MONTHS.indexOf(parts[3]!.toLowerCase());
    let year = Number(parts[4]);
    const hour = Number(parts[5]);
    const minute = Number(parts[6]);
    const second = Number(parts[7]);
    if (obsolete) {
      const currentYear = new Date(receivedAtMs).getUTCFullYear();
      year += Math.floor(currentYear / 100) * 100;
      const futureLimit = new Date(receivedAtMs);
      futureLimit.setUTCFullYear(currentYear + 50);
      if (Date.UTC(year, month, day, hour, minute, second) > futureLimit.getTime()) year -= 100;
    }
    const retryAtMs = readVkRetryAtMs(Date.UTC(year, month, day, hour, minute, second));
    if (retryAtMs === undefined || retryAtMs <= receivedAtMs) return undefined;
    const date = new Date(retryAtMs);
    return date.getUTCFullYear() === year &&
      date.getUTCMonth() === month &&
      date.getUTCDate() === day &&
      date.getUTCDay() === weekday &&
      date.getUTCHours() === hour &&
      date.getUTCMinutes() === minute &&
      date.getUTCSeconds() === second
      ? retryAtMs
      : undefined;
  }

  private async readVkResponsePayload(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new VkApiRequestError('VK API вернул нечитаемый ответ.', 'invalid_json', true);
    }
  }

  private classifyVkRequestError(error: unknown): {
    error: VkApiRequestError;
    code: string;
    retryable: boolean;
  } {
    if (error instanceof VkApiRequestError) {
      return { error, code: error.code, retryable: error.retryable };
    }

    const wrapped = new VkApiRequestError(formatVkParsingError(error), 'unknown', true);
    return { error: wrapped, code: wrapped.code, retryable: wrapped.retryable };
  }

  private isRetryableVkApiErrorCode(code: number): boolean {
    if (VK_API_RETRYABLE_ERROR_CODES.has(code)) {
      return true;
    }
    if (VK_API_TERMINAL_ERROR_CODES.has(code)) {
      return false;
    }

    return false;
  }

  private resolveVkRequestRetryDelayMs(attempt: number, code: string): number {
    const rateLimitDelayMs = code === `vk_${VK_API_RATE_LIMIT_ERROR_CODE}` ? 1_000 : 0;
    const baseMs = Math.max(250, rateLimitDelayMs);
    return Math.min(5_000, baseMs * 2 ** Math.max(0, attempt - 1));
  }

  private normalizeBaseUrl(value: string): string {
    return value.replace(/\/+$/u, '');
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private readNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
