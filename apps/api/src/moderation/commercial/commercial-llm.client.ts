import { performance } from 'node:perf_hooks';
import {
  readBoundedResponseBuffer,
  EmptyResponseBodyError,
  ResponseByteLimitExceededError,
} from '../../common/bounded-response-buffer';
import {
  buildCommercialLlmRequest,
  COMMERCIAL_LLM_MODEL_ALIAS,
  COMMERCIAL_LLM_MODEL_SHA256,
  COMMERCIAL_LLM_POLICY_VERSION,
  COMMERCIAL_LLM_PROMPT_SHA256,
  COMMERCIAL_LLM_RUNTIME_VERSION,
  COMMERCIAL_LLM_RUNTIME_IMAGE_SHA256,
  COMMERCIAL_LLM_CHAT_TEMPLATE_SHA256,
  parseCommercialLlmDecision,
  type CommercialLlmDecision,
  type CommercialLlmObservationResult,
} from './commercial-llm.protocol';

export const COMMERCIAL_LLM_RESPONSE_MAX_BYTES = 16 * 1024;
export const COMMERCIAL_LLM_DEFAULT_TIMEOUT_MS = 60_000;
export type CommercialLlmFailureKind =
  | 'BUSY'
  | 'INVALID_INPUT'
  | 'INVALID_ENDPOINT'
  | 'HTTP_ERROR'
  | 'RESPONSE_TOO_LARGE'
  | 'INVALID_RESPONSE'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'UNAVAILABLE';

export class CommercialLlmError extends Error {
  constructor(readonly kind: CommercialLlmFailureKind) {
    super(`Commercial LLM ${kind}`);
    this.name = 'CommercialLlmError';
  }
}

export type CommercialLlmResult = CommercialLlmDecision & {
  modelAlias: typeof COMMERCIAL_LLM_MODEL_ALIAS;
  modelSha256: typeof COMMERCIAL_LLM_MODEL_SHA256;
  promptSha256: string;
  runtimeVersion: typeof COMMERCIAL_LLM_RUNTIME_VERSION;
  runtimeImageSha256: typeof COMMERCIAL_LLM_RUNTIME_IMAGE_SHA256;
  chatTemplateSha256: typeof COMMERCIAL_LLM_CHAT_TEMPLATE_SHA256;
  policyVersion: typeof COMMERCIAL_LLM_POLICY_VERSION;
  durationMs: number;
};

export type CommercialLlmClientOptions = {
  endpoint: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type CommercialLlmHttpLifecycle = Readonly<{
  beforeDispatch: () => Promise<void>;
  dispatched: () => void;
  completed: () => void;
}>;
export type CommercialLlmHttpClassifier = {
  classifyWithLifecycle(
    excerpt: string,
    signal: AbortSignal | undefined,
    lifecycle: CommercialLlmHttpLifecycle,
  ): Promise<CommercialLlmObservationResult>;
};

export function commercialLlmCompletionUrl(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new CommercialLlmError('INVALID_ENDPOINT');
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    url.protocol !== 'http:' ||
    (!local && !(url.hostname === 'gemma-commercial-shadow' && url.port === '8080')) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new CommercialLlmError('INVALID_ENDPOINT');
  return new URL('/v1/chat/completions', url).toString();
}

export class CommercialLlmClient {
  private readonly completionUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CommercialLlmClientOptions) {
    this.completionUrl = commercialLlmCompletionUrl(options.endpoint);
    this.timeoutMs = options.timeoutMs ?? COMMERCIAL_LLM_DEFAULT_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > COMMERCIAL_LLM_DEFAULT_TIMEOUT_MS
    )
      throw new CommercialLlmError('INVALID_INPUT');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async classify(excerpt: string, signal?: AbortSignal): Promise<CommercialLlmResult> {
    return this.execute(excerpt, signal);
  }

  async classifyWithLifecycle(
    excerpt: string,
    signal: AbortSignal | undefined,
    lifecycle: CommercialLlmHttpLifecycle,
  ): Promise<CommercialLlmResult> {
    return this.execute(excerpt, signal, lifecycle);
  }

  private async execute(
    excerpt: string,
    signal?: AbortSignal,
    lifecycle?: CommercialLlmHttpLifecycle,
  ): Promise<CommercialLlmResult> {
    let request: ReturnType<typeof buildCommercialLlmRequest>;
    try {
      request = buildCommercialLlmRequest(excerpt);
    } catch {
      throw new CommercialLlmError('INVALID_INPUT');
    }
    if (signal?.aborted) throw new CommercialLlmError('ABORTED');
    const startedAt = performance.now();
    const controller = new AbortController();
    const onAbort = () => controller.abort(new CommercialLlmError('ABORTED'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new CommercialLlmError('TIMEOUT')),
      this.timeoutMs,
    );
    let rejectAborted: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', rejectAborted, { once: true });
    });
    try {
      const decision = await Promise.race([
        this.requestDecision(request, controller.signal, lifecycle),
        aborted,
      ]);
      return {
        ...decision,
        modelAlias: COMMERCIAL_LLM_MODEL_ALIAS,
        modelSha256: COMMERCIAL_LLM_MODEL_SHA256,
        promptSha256: COMMERCIAL_LLM_PROMPT_SHA256,
        runtimeVersion: COMMERCIAL_LLM_RUNTIME_VERSION,
        runtimeImageSha256: COMMERCIAL_LLM_RUNTIME_IMAGE_SHA256,
        chatTemplateSha256: COMMERCIAL_LLM_CHAT_TEMPLATE_SHA256,
        policyVersion: COMMERCIAL_LLM_POLICY_VERSION,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      };
    } catch (error: unknown) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof CommercialLlmError) throw error;
      if (error instanceof ResponseByteLimitExceededError)
        throw new CommercialLlmError('RESPONSE_TOO_LARGE');
      if (error instanceof EmptyResponseBodyError) throw new CommercialLlmError('INVALID_RESPONSE');
      // FLAG: Error messages deliberately contain no source, URL, response or remote text.
      throw new CommercialLlmError('UNAVAILABLE');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      if (rejectAborted) controller.signal.removeEventListener('abort', rejectAborted);
    }
  }

  private async requestDecision(
    request: ReturnType<typeof buildCommercialLlmRequest>,
    signal: AbortSignal,
    lifecycle?: CommercialLlmHttpLifecycle,
  ): Promise<CommercialLlmDecision> {
    signal.throwIfAborted();
    await lifecycle?.beforeDispatch();
    signal.throwIfAborted();
    // FLAG: This synchronous hook is the actual HTTP handoff, not caller admission or timeout.
    // The exact physical lease must already be pinned before fetch can start computing.
    lifecycle?.dispatched();
    const response = await this.fetchImpl(this.completionUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(request),
      signal,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new CommercialLlmError('HTTP_ERROR');
    }
    if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) {
      void response.body?.cancel().catch(() => undefined);
      throw new CommercialLlmError('INVALID_RESPONSE');
    }
    const bytes = await readBoundedResponseBuffer(
      response,
      COMMERCIAL_LLM_RESPONSE_MAX_BYTES,
      signal,
    );
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new CommercialLlmError('INVALID_RESPONSE');
    }
    const decision = parseCommercialLlmEnvelope(envelope, COMMERCIAL_LLM_MODEL_ALIAS);
    // FLAG: Only a complete bounded, validated response proves the physical request finished.
    // This hook belongs to the real request promise, even if its caller lost Promise.race.
    lifecycle?.completed();
    return decision;
  }
}

export function parseCommercialLlmEnvelope(
  envelope: Record<string, unknown>,
  expectedAlias: string,
): CommercialLlmDecision {
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope) ||
    envelope.model !== expectedAlias ||
    !Array.isArray(envelope.choices) ||
    envelope.choices.length !== 1
  )
    throw new CommercialLlmError('INVALID_RESPONSE');
  const choice = object(envelope.choices[0]);
  const message = object(choice.message);
  // FLAG: A token-limit response, reasoning, refusal or tool request is incomplete
  // classification, even when its visible content happens to be valid JSON.
  if (
    choice.finish_reason !== 'stop' ||
    message.role !== 'assistant' ||
    typeof message.content !== 'string' ||
    (message.refusal !== undefined && message.refusal !== null) ||
    (message.tool_calls !== undefined &&
      (!Array.isArray(message.tool_calls) || message.tool_calls.length !== 0)) ||
    (message.reasoning_content !== undefined &&
      message.reasoning_content !== null &&
      message.reasoning_content !== '') ||
    message.function_call !== undefined
  )
    throw new CommercialLlmError('INVALID_RESPONSE');
  let decision: CommercialLlmDecision | null;
  try {
    decision = parseCommercialLlmDecision(JSON.parse(message.content));
  } catch {
    throw new CommercialLlmError('INVALID_RESPONSE');
  }
  if (!decision) throw new CommercialLlmError('INVALID_RESPONSE');
  return decision;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
