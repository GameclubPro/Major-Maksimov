import { createHash, randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { readBoundedResponseBuffer } from '../../common/bounded-response-buffer';
import {
  commercialLlmCompletionUrl,
  COMMERCIAL_LLM_DEFAULT_TIMEOUT_MS,
  CommercialLlmError,
  parseCommercialLlmEnvelope,
  parseCommercialLlmCompletionContent,
} from './commercial-llm.client';
import {
  CommercialLlmPoolMailbox,
  type CommercialLlmPoolReservation,
} from './commercial-llm-pool.mailbox';
import {
  COMMERCIAL_LLM_POOL_PROFILES,
  COMMERCIAL_LLM_POOL_CPU_MIN_REMAINING_MS,
  COMMERCIAL_LLM_POOL_RESPONSE_BYTES,
} from './commercial-llm-pool.protocol';
import {
  CommercialLlmShadowLease,
  COMMERCIAL_LLM_LEASE_KEY,
  COMMERCIAL_LLM_COOLDOWN_KEY,
} from './commercial-llm-shadow.lease';

// FLAG: The CPU node shares the legacy physical lease. Its availability never serializes GPU PCs.
export class CommercialLlmPoolServer {
  private session = randomUUID();
  private registered = false;
  private active = false;
  private draining: Promise<void> | null = null;
  private quarantinedLease: string | null = null;
  private checkedAt = 0;
  private closed = false;
  private readonly url: string;
  private readonly lease: CommercialLlmShadowLease;

  constructor(
    private readonly redis: Redis,
    private readonly mailbox: CommercialLlmPoolMailbox,
    endpoint: string,
    private readonly hasHeadroom: () => Promise<boolean>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.url = commercialLlmCompletionUrl(endpoint);
    this.lease = new CommercialLlmShadowLease(redis);
  }

  async tick(): Promise<void> {
    if (this.closed || Date.now() - this.checkedAt < 1_000) return;
    this.checkedAt = Date.now();
    try {
      if (!this.registered) {
        if (this.active || !(await this.mailbox.acquireWorker('server-9b', this.session))) return;
        this.registered = true;
      }
      if (this.active) {
        await this.mailbox.refreshWorker('server-9b', this.session, false);
        return;
      }
      const idle = await this.idle();
      const [busy, cooldown] = await this.redis.mget(
        COMMERCIAL_LLM_LEASE_KEY,
        COMMERCIAL_LLM_COOLDOWN_KEY,
      );
      const ready =
        !this.quarantinedLease &&
        idle &&
        !busy &&
        !cooldown &&
        (await this.hasHeadroom()) &&
        (await this.identityMatches());
      await this.mailbox.refreshWorker('server-9b', this.session, ready);
    } catch {
      this.registered = false;
      this.session = randomUUID();
    }
  }

  async dispatch(
    reservation: CommercialLlmPoolReservation,
    signal?: AbortSignal,
    shutdownSignal?: AbortSignal,
  ): Promise<void> {
    if (reservation.nodeId !== 'server-9b') throw new CommercialLlmError('INVALID_INPUT');
    if (
      this.closed ||
      this.active ||
      this.quarantinedLease ||
      !this.registered ||
      reservation.session !== this.session ||
      reservation.deadlineAtMs - Date.now() < COMMERCIAL_LLM_POOL_CPU_MIN_REMAINING_MS ||
      signal?.aborted ||
      shutdownSignal?.aborted
    ) {
      await this.mailbox.releaseUndispatched(reservation);
      throw new CommercialLlmError('BUSY');
    }
    this.active = true;
    let drained!: () => void;
    this.draining = new Promise<void>((resolve) => {
      drained = resolve;
    });
    let token: string | null = null;
    let dispatched = false;
    let completed = false;
    try {
      token = await this.lease.acquire();
      if (
        !token ||
        !(await this.hasHeadroom()) ||
        this.closed ||
        signal?.aborted ||
        shutdownSignal?.aborted ||
        reservation.deadlineAtMs - Date.now() < COMMERCIAL_LLM_POOL_CPU_MIN_REMAINING_MS
      )
        throw new CommercialLlmError('BUSY');
      await this.mailbox.refreshWorker('server-9b', this.session, false);
      if (
        !(await this.lease.retainUntilReleased(token)) ||
        this.closed ||
        signal?.aborted ||
        shutdownSignal?.aborted ||
        reservation.deadlineAtMs - Date.now() < COMMERCIAL_LLM_POOL_CPU_MIN_REMAINING_MS
      )
        throw new CommercialLlmError('BUSY');
      // FLAG: Source expiry revokes publication, not proof of physical completion. Drain an
      // accepted CPU request under the existing client limit; only shutdown may abort it early.
      const workSignal = AbortSignal.any([
        ...(shutdownSignal ? [shutdownSignal] : []),
        AbortSignal.timeout(COMMERCIAL_LLM_DEFAULT_TIMEOUT_MS),
      ]);
      dispatched = true;
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        body: reservation.body,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        signal: workSignal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      });
      if (
        !response.ok ||
        !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new CommercialLlmError('HTTP_ERROR');
      }
      const bytes = await readBoundedResponseBuffer(
        response,
        COMMERCIAL_LLM_POOL_RESPONSE_BYTES,
        workSignal,
      );
      const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const envelope = JSON.parse(body);
      const modelAlias = COMMERCIAL_LLM_POOL_PROFILES['server-9b'].identity.modelAlias;
      parseCommercialLlmCompletionContent(envelope, modelAlias);
      completed = true;
      // FLAG: Retain the actual terminal response before decision validation, as GPU workers do.
      // It lets exact-attempt cleanup release the pool slot even for an invalid decision;
      // mailbox readers still validate the decision before marking any job complete.
      if (
        (await this.lease.owns(token)) &&
        !this.closed &&
        !signal?.aborted &&
        !workSignal.aborted &&
        Date.now() < reservation.deadlineAtMs
      )
        await this.mailbox.respond('server-9b', reservation.session, reservation.id, body);
      parseCommercialLlmEnvelope(envelope, modelAlias);
    } catch (error) {
      if (error instanceof CommercialLlmError) throw error;
      throw new CommercialLlmError(
        signal?.aborted || shutdownSignal?.aborted ? 'ABORTED' : 'UNAVAILABLE',
      );
    } finally {
      // FLAG: An aborted HTTP request is not evidence that llama.cpp stopped computing.
      // /slots can overtake queued inference. Keep the pinned lease until managed recovery;
      // only an exact-model terminal envelope or a definite non-dispatch may release it here.
      // Invalid decision content still fails classification; it does not keep completed CPU work busy.
      if (!dispatched) await this.mailbox.releaseUndispatched(reservation).catch(() => false);
      if (token) {
        if (!dispatched || completed) await this.lease.release(token).catch(() => undefined);
        else this.quarantinedLease = token;
      }
      this.active = false;
      drained();
      this.draining = null;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.draining;
    if (this.registered)
      await this.mailbox.releaseWorker('server-9b', this.session).catch(() => undefined);
  }

  private async idle(): Promise<boolean> {
    try {
      const signal = AbortSignal.timeout(750);
      const response = await this.fetchImpl(new URL('/slots', this.url), {
        signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      });
      if (
        !response.ok ||
        !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')
      ) {
        await response.body?.cancel();
        return false;
      }
      const slots: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          await readBoundedResponseBuffer(response, 65_536, signal),
        ),
      );
      // FLAG: b11804 /health ignores fail_on_no_slot. This observes occupancy, not cancellation.
      if (!Array.isArray(slots) || slots.length !== 1) return false;
      const slot: unknown = slots[0];
      if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return false;
      const state = slot as Record<string, unknown>;
      return state.id === 0 && state.n_ctx === 4096 && state.is_processing === false;
    } catch {
      return false;
    }
  }

  private async identityMatches(): Promise<boolean> {
    try {
      const read = async (path: string): Promise<Record<string, unknown>> => {
        const signal = AbortSignal.timeout(750);
        const response = await this.fetchImpl(new URL(path, this.url), {
          signal,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('identity_unavailable');
        }
        return JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(
            await readBoundedResponseBuffer(response, 65_536, signal),
          ),
        ) as Record<string, unknown>;
      };
      const props = await read('/props');
      const models = await read('/v1/models');
      const identity = COMMERCIAL_LLM_POOL_PROFILES['server-9b'].identity;
      return (
        props.total_slots === 1 &&
        props.endpoint_slots === true &&
        typeof props.chat_template === 'string' &&
        createHash('sha256').update(props.chat_template).digest('hex') ===
          identity.chatTemplateSha256 &&
        Array.isArray(models.data) &&
        models.data.length === 1 &&
        models.data[0]?.id === identity.modelAlias
      );
    } catch {
      return false;
    }
  }
}
