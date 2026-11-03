import type { Config } from './config.js';
import { HttpAdmissionDeferred, HttpLimiter } from './limiter.js';
import { record, parseMessage, type Message } from './types.js';
import { HttpTelemetry, type HttpPurpose, type TransportMetrics } from './telemetry.js';

const ERASER_WEBHOOK_UPDATE_TYPES = [
  'message_created',
  'message_edited',
  'message_removed',
  'bot_added',
  'bot_removed',
] as const;

export class MaxError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly attempted: boolean,
    readonly retryAfterMs = 1000,
  ) {
    super(`MAX ${status || 'transport'} ${code}`);
  }
}
export type MaxTransport = {
  metrics?(): TransportMetrics;
  rights(chatId: string, before?: () => Promise<void>, purpose?: 'safety'): Promise<void>;
  actorRights(chatId: string, actorUserId: string, before?: () => Promise<void>): Promise<void>;
  pin(chatId: string): Promise<string | null>;
  page(chatId: string, upperMs: number, lowerMs?: number, purpose?: 'safety'): Promise<Message[]>;
  remove(chatId: string, messageId: string, before: () => Promise<void>): Promise<void>;
  presence(chatId: string, messageId: string): Promise<'present' | 'unknown'>;
};
export class MaxClient implements MaxTransport {
  constructor(
    private readonly config: Config,
    private readonly limiter: Pick<HttpLimiter, 'acquire' | 'cooldown'>,
    private readonly http: typeof fetch = fetch,
    private readonly telemetry = new HttpTelemetry(),
  ) {}
  metrics(): TransportMetrics {
    return this.telemetry.snapshot();
  }
  private async request(
    method: string,
    path: string,
    options: {
      chatDelete?: string;
      before?: () => Promise<void>;
      body?: unknown;
      purpose?: 'safety';
      metric: HttpPurpose;
    },
  ): Promise<Record<string, unknown>> {
    try {
      await this.limiter.acquire(options.chatDelete, undefined, options.purpose);
    } catch (error) {
      if (error instanceof HttpAdmissionDeferred) {
        this.telemetry.admission('cooldown', error.retryAfterMs);
        throw new MaxError(429, 'rate_limit_cooldown', false, error.retryAfterMs);
      }
      this.telemetry.admission('unavailable');
      throw error;
    }
    try {
      await options.before?.();
    } catch (error) {
      this.telemetry.admission('guard');
      throw error;
    }
    const target = new URL(path, this.config.apiBaseUrl);
    const request: RequestInit = {
      method,
      headers: { Authorization: this.config.botToken, 'Content-Type': 'application/json' },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    };
    let response: Response;
    try {
      // FLAG: Count actual transport only after admission and the final effect guard.
      // A completed HTTP response alone never counts as a confirmed DELETE.
      this.telemetry.attempt(options.metric);
      response = await this.http(target, request);
    } catch {
      this.telemetry.transportError(options.metric);
      throw new MaxError(0, 'transport_unknown', method === 'DELETE');
    }
    this.telemetry.response(options.metric, response.status);
    let body: Record<string, unknown> | null = null;
    try {
      body = record(await response.json());
    } catch {
      /* An invalid response never certifies an effect. */
    }
    if (!response.ok) {
      const code =
        typeof body?.code === 'string' && /^[a-zA-Z_.-]{1,100}$/.test(body.code)
          ? body.code
          : 'unclassified';
      const retry = response.headers.get('retry-after');
      const retryAfterMs =
        retry && /^\d+(\.\d+)?$/.test(retry)
          ? Math.ceil(Number(retry) * 1000)
          : retry
            ? Math.max(1000, Date.parse(retry) - Date.now())
            : 1000;
      if (response.status === 429) {
        this.telemetry.cooldown(Number.isFinite(retryAfterMs) ? retryAfterMs : 1000);
        try {
          await this.limiter.cooldown(Number.isFinite(retryAfterMs) ? retryAfterMs : 1000);
        } catch {
          // FLAG: A failed cooldown store cannot replace the known no-effect HTTP rejection.
          // The limiter keeps admission closed until its observed deadline is persisted.
        }
      }
      throw new MaxError(
        response.status,
        code,
        method === 'DELETE' && response.status !== 429,
        Number.isFinite(retryAfterMs) ? retryAfterMs : 1000,
      );
    }
    if (!body) throw new MaxError(0, 'malformed_response', method === 'DELETE');
    return body;
  }
  async rights(chatId: string, before?: () => Promise<void>, purpose?: 'safety'): Promise<void> {
    const member = await this.request('GET', `/chats/${encodeURIComponent(chatId)}/members/me`, {
      before,
      purpose,
      metric: purpose === 'safety' ? 'safety_rights' : 'bot_rights',
    });
    const role = String(member.role ?? member.status ?? '').toLowerCase();
    const owner =
      member.is_owner === true || member.isOwner === true || ['owner', 'creator'].includes(role);
    const admin = owner || member.is_admin === true || member.isAdmin === true || role === 'admin';
    if (String(member.user_id ?? record(member.user)?.user_id) !== this.config.botId)
      throw new MaxError(0, 'membership_unknown', false);
    if (!admin) {
      const explicitNonAdmin =
        member.is_admin === false ||
        member.isAdmin === false ||
        ['member', 'user', 'removed'].includes(role);
      throw new MaxError(
        explicitNonAdmin ? 403 : 0,
        explicitNonAdmin ? 'eraser_rights_missing' : 'membership_unknown',
        false,
      );
    }
    if (owner) return;
    if (
      !Array.isArray(member.permissions) ||
      member.permissions.some((permission) => typeof permission !== 'string')
    )
      throw new MaxError(0, 'membership_unknown', false);
    if (!member.permissions.includes('read_all_messages') || !member.permissions.includes('write'))
      throw new MaxError(403, 'eraser_rights_missing', false);
  }

  async actorRights(
    chatId: string,
    actorUserId: string,
    before?: () => Promise<void>,
  ): Promise<void> {
    const query = new URLSearchParams({ user_ids: actorUserId });
    const result = await this.request(
      'GET',
      `/chats/${encodeURIComponent(chatId)}/members?${query}`,
      { before, metric: 'actor_rights' },
    );
    if (!Array.isArray(result.members) || result.members.length !== 1)
      throw new MaxError(0, 'actor_membership_unknown', false);
    const member = record(result.members[0]);
    if (
      !member ||
      String(member.user_id) !== actorUserId ||
      member.is_bot !== false ||
      ['is_admin', 'is_owner', 'isAdmin', 'isOwner'].some(
        (key) => member[key] !== undefined && typeof member[key] !== 'boolean',
      )
    )
      throw new MaxError(0, 'actor_membership_unknown', false);
    const role = String(member.role ?? member.status ?? '').toLowerCase();
    if (
      member.is_owner === true ||
      member.isOwner === true ||
      member.is_admin === true ||
      member.isAdmin === true ||
      ['owner', 'creator', 'admin'].includes(role)
    )
      return;
    if (
      member.is_admin === false ||
      member.isAdmin === false ||
      ['member', 'user', 'removed'].includes(role)
    )
      throw new MaxError(403, 'actor_rights_missing', false);
    throw new MaxError(0, 'actor_membership_unknown', false);
  }

  async pin(chatId: string): Promise<string | null> {
    const result = await this.request('GET', `/chats/${encodeURIComponent(chatId)}/pin`, {
      metric: 'pin',
    });
    // FLAG: MAX permits an omitted message; only the exact empty envelope confirms no pin.
    if (result.message === null || Object.keys(result).length === 0) return null;
    const row = record(result.message),
      body = record(row?.body),
      recipient = record(row?.recipient);
    if (!body || typeof body.mid !== 'string' || !body.mid || String(recipient?.chat_id) !== chatId)
      throw new MaxError(0, 'pin_unknown', false);
    return body.mid;
  }
  async page(
    chatId: string,
    upperMs: number,
    lowerMs?: number,
    purpose?: 'safety',
  ): Promise<Message[]> {
    const query = new URLSearchParams({
      chat_id: chatId,
      count: '100',
      from: String(upperMs),
      ...(lowerMs === undefined ? {} : { to: String(lowerMs) }),
    });
    const result = await this.request('GET', `/messages?${query}`, {
      purpose,
      metric:
        purpose === 'safety' ? 'safety_scan' : lowerMs === undefined ? 'history_scan' : 'live_scan',
    });
    if (!Array.isArray(result.messages) || result.messages.length > 100)
      throw new MaxError(0, 'history_unknown', false);
    const items = result.messages.map((row) => parseMessage(row, chatId));
    if (items.some((row) => !row)) throw new MaxError(0, 'history_unknown', false);
    const rows = items as Message[];
    if (
      rows.some(
        (row) => row.sourceMs > upperMs || (lowerMs !== undefined && row.sourceMs < lowerMs),
      )
    )
      throw new MaxError(0, 'history_boundary_unknown', false);
    if (new Set(rows.map((row) => row.id)).size !== rows.length)
      throw new MaxError(0, 'history_duplicate', false);
    return rows.sort((a, b) => b.sourceMs - a.sourceMs || b.id.localeCompare(a.id));
  }
  async remove(chatId: string, messageId: string, before: () => Promise<void>): Promise<void> {
    const result = await this.request(
      'DELETE',
      `/messages?${new URLSearchParams({ message_id: messageId })}`,
      { chatDelete: chatId, before, metric: 'delete' },
    );
    if (result.success !== true) throw new MaxError(200, 'delete_unconfirmed', true);
    this.telemetry.acknowledgeDelete();
  }
  async presence(chatId: string, messageId: string): Promise<'present' | 'unknown'> {
    try {
      const result = await this.request('GET', `/messages/${encodeURIComponent(messageId)}`, {
        metric: 'presence',
      });
      const message = parseMessage(result, chatId) ?? parseMessage(result.message, chatId);
      return message?.id === messageId ? 'present' : 'unknown';
    } catch (error) {
      // FLAG: MAX documents 404 as missing OR inaccessible; no error code proves absence.
      if (error instanceof MaxError && error.status === 404) return 'unknown';
      throw error;
    }
  }
  async subscribe(): Promise<{ updateTypes: 'verified' | 'unknown' }> {
    if (!this.config.webhookUrl) return { updateTypes: 'unknown' };
    const identity = await this.request('GET', '/me', { metric: 'identity' });
    if (String(identity.user_id) !== this.config.botId || identity.is_bot !== true)
      throw new Error('Configured Eraser bot identity does not match its token');
    const subscriptions = await this.request('GET', '/subscriptions', { metric: 'subscriptions' });
    const list = subscriptions.subscriptions;
    if (!Array.isArray(list)) throw new Error('MAX subscriptions response unknown');
    if (
      list.some(
        (row) =>
          typeof record(row)?.url !== 'string' || record(row)?.url !== this.config.webhookUrl,
      )
    )
      throw new Error('Conflicting Eraser webhook subscription');
    const result = await this.request('POST', '/subscriptions', {
      metric: 'subscriptions',
      body: {
        url: this.config.webhookUrl,
        secret: this.config.webhookSecret,
        update_types: ERASER_WEBHOOK_UPDATE_TYPES,
      },
    });
    if (result.success !== true) throw new Error('MAX webhook subscription unconfirmed');
    const confirmed = await this.request('GET', '/subscriptions', { metric: 'subscriptions' });
    if (
      !Array.isArray(confirmed.subscriptions) ||
      confirmed.subscriptions.length !== 1 ||
      record(confirmed.subscriptions[0])?.url !== this.config.webhookUrl
    )
      throw new Error('MAX webhook subscription readback unconfirmed');
    const updateTypes = record(confirmed.subscriptions[0])?.update_types;
    // FLAG: MAX documents Subscription.update_types as optional and nullable:
    // https://dev.max.ru/docs-api/methods/GET/subscriptions
    // Missing type evidence preserves URL confirmation, but never certifies event coverage.
    if (updateTypes === undefined || updateTypes === null) return { updateTypes: 'unknown' };
    if (
      !Array.isArray(updateTypes) ||
      updateTypes.some((value) => typeof value !== 'string' || !value.trim())
    )
      throw new Error('MAX webhook subscription readback unconfirmed');
    const reported = new Set(updateTypes.map((value: string) => value.trim().toLowerCase()));
    if (ERASER_WEBHOOK_UPDATE_TYPES.some((value) => !reported.has(value)))
      throw new Error('MAX webhook subscription readback unconfirmed');
    return { updateTypes: 'verified' };
  }
}
