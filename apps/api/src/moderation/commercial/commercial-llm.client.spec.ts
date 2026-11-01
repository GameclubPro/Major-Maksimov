import {
  CommercialLlmClient,
  CommercialLlmError,
  commercialLlmCompletionUrl,
  COMMERCIAL_LLM_RESPONSE_MAX_BYTES,
} from './commercial-llm.client';
import {
  COMMERCIAL_LLM_MODEL_ALIAS,
  COMMERCIAL_LLM_MODEL_SHA256,
  COMMERCIAL_LLM_PROMPT_SHA256,
  COMMERCIAL_LLM_RUNTIME_IMAGE_SHA256,
} from './commercial-llm.protocol';

const verdict = { classification: 'NOT_COMMERCIAL', reasonCodes: ['ORDINARY_DISCUSSION'] };
const completion = () => ({
  model: COMMERCIAL_LLM_MODEL_ALIAS,
  choices: [
    {
      finish_reason: 'stop',
      message: { role: 'assistant', content: JSON.stringify(verdict) },
    },
  ],
});
const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const clientWith = (fetchImpl: typeof fetch, timeoutMs?: number) =>
  new CommercialLlmClient({
    endpoint: 'http://gemma-commercial-shadow:8080',
    fetchImpl,
    timeoutMs,
  });

describe('bounded commercial LLM HTTP client', () => {
  it('returns only validated verdict and pinned protocol identities over an internal POST', async () => {
    const fetchImpl = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(jsonResponse(completion()));
    const result = await clientWith(fetchImpl).classify('Доброе утро, соседи!');
    expect(result).toMatchObject({
      ...verdict,
      modelAlias: COMMERCIAL_LLM_MODEL_ALIAS,
      modelSha256: COMMERCIAL_LLM_MODEL_SHA256,
      promptSha256: COMMERCIAL_LLM_PROMPT_SHA256,
      runtimeImageSha256: COMMERCIAL_LLM_RUNTIME_IMAGE_SHA256,
      runtimeVersion: 'llama.cpp-b11804',
      policyVersion: 'commercial-llm-shadow-v1',
      durationMs: expect.any(Number),
    });
    expect(result).not.toHaveProperty('content');
    expect(result).not.toHaveProperty('confidence');
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://gemma-commercial-shadow:8080/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      }),
    );
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body.response_format.json_schema.schema.properties.classification.enum).toEqual([
      'COMMERCIAL',
      'NOT_COMMERCIAL',
      'UNSURE',
    ]);
  });

  it.each([
    'https://example.com',
    'http://example.com:8080',
    'http://gemma-commercial-shadow:8081',
    'http://user:secret@gemma-commercial-shadow:8080',
    'http://gemma-commercial-shadow:8080/proxy',
    'http://gemma-commercial-shadow:8080/?key=secret',
    'http://gemma-commercial-shadow:8080/#fragment',
    'garbage',
  ])('rejects endpoint egress or credentials: %s', (endpoint) => {
    expect(() => commercialLlmCompletionUrl(endpoint)).toThrow(CommercialLlmError);
  });

  it.each(['http://127.0.0.1:12345', 'http://localhost:12345', 'http://[::1]:12345'])(
    'permits a loopback integration fixture: %s',
    (endpoint) => expect(commercialLlmCompletionUrl(endpoint)).toContain('/v1/chat/completions'),
  );

  it.each(['length', 'tool_calls', null])(
    'refuses an incomplete %s finish even with valid JSON',
    async (finishReason) => {
      const payload = completion();
      Object.assign(payload.choices[0]!, { finish_reason: finishReason });
      await expect(
        clientWith(async () => jsonResponse(payload)).classify('Привет'),
      ).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    },
  );

  it.each([
    { model: 'other-model' },
    { choices: [] },
    { choices: [{ finish_reason: 'stop', message: { role: 'user', content: '{}' } }] },
    {
      choices: [
        { finish_reason: 'stop', message: { role: 'assistant', content: '```json\n{}\n```' } },
      ],
    },
    {
      choices: [
        { finish_reason: 'stop', message: { role: 'assistant', content: '{"classification":' } },
      ],
    },
    {
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: JSON.stringify({ ...verdict, confidence: 1 }) },
        },
      ],
    },
    {
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: JSON.stringify(verdict),
            reasoning_content: 'private thought',
          },
        },
      ],
    },
    {
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: JSON.stringify(verdict), refusal: 'no' },
        },
      ],
    },
    {
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: JSON.stringify(verdict), tool_calls: [{}] },
        },
      ],
    },
  ])('refuses model mismatch or invalid envelope/content %#', async (change) => {
    await expect(
      clientWith(async () => jsonResponse({ ...completion(), ...change })).classify('Привет'),
    ).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
  });

  it('limits actual decoded stream bytes despite a false short Content-Length', async () => {
    const cancel = jest.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(COMMERCIAL_LLM_RESPONSE_MAX_BYTES));
          controller.enqueue(new Uint8Array(1));
        },
        cancel,
      }),
      { headers: { 'content-type': 'application/json', 'content-length': '1' } },
    );
    await expect(clientWith(async () => response).classify('Привет')).rejects.toMatchObject({
      kind: 'RESPONSE_TOO_LARGE',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('applies one deadline to response body consumption and aborts the reader', async () => {
    const cancel = jest.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { 'content-type': 'application/json' },
    });
    await expect(clientWith(async () => response, 10).classify('Привет')).rejects.toMatchObject({
      kind: 'TIMEOUT',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('bounds a fetch that never returns and signals cancellation', async () => {
    let fetchSignal: AbortSignal | undefined;
    const fetchImpl: typeof fetch = async (_url, options) => {
      fetchSignal = options?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    };
    await expect(clientWith(fetchImpl, 10).classify('Привет')).rejects.toMatchObject({
      kind: 'TIMEOUT',
    });
    expect(fetchSignal?.aborted).toBe(true);
  });

  it('honors caller cancellation during inference and never forwards its private reason', async () => {
    const controller = new AbortController();
    const fetchImpl: typeof fetch = async () => {
      controller.abort(new Error('private source text'));
      return new Promise<Response>(() => undefined);
    };
    await expect(clientWith(fetchImpl).classify('Привет', controller.signal)).rejects.toMatchObject(
      {
        kind: 'ABORTED',
        message: 'Commercial LLM ABORTED',
      },
    );
  });

  it('rejects pre-aborted requests and invalid source before opening a connection', async () => {
    const fetchImpl = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
    await expect(clientWith(fetchImpl).classify('x'.repeat(2501))).rejects.toMatchObject({
      kind: 'INVALID_INPUT',
    });
    await expect(
      clientWith(fetchImpl).classify('Привет', AbortSignal.abort()),
    ).rejects.toMatchObject({ kind: 'ABORTED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    new Response('private server error', { status: 503 }),
    new Response('private proxy page', { headers: { 'content-type': 'text/html' } }),
  ])('does not retain or expose an HTTP error body %#', async (response) => {
    await expect(clientWith(async () => response).classify('Привет')).rejects.toThrow(
      /^Commercial LLM (HTTP_ERROR|INVALID_RESPONSE)$/u,
    );
  });

  it('does not expose network exception details', async () => {
    await expect(
      clientWith(async () => {
        throw new Error('sensitive host data');
      }).classify('Привет'),
    ).rejects.toMatchObject({ kind: 'UNAVAILABLE', message: 'Commercial LLM UNAVAILABLE' });
  });

  it('pins before actual dispatch and proves completion only after bounded validation', async () => {
    const events: string[] = [];
    const client = clientWith(async () => {
      events.push('fetch');
      return jsonResponse(completion());
    });
    await client.classifyWithLifecycle('Привет', undefined, {
      beforeDispatch: async () => {
        events.push('pin');
      },
      dispatched: () => {
        events.push('dispatch');
      },
      completed: () => {
        events.push('complete');
      },
    });
    expect(events).toEqual(['pin', 'dispatch', 'fetch', 'complete']);
  });

  it('never dispatches when persistent pinning fails or cancellation arrives while pinning', async () => {
    for (const gate of ['pin', 'abort'] as const) {
      const controller = new AbortController();
      const fetchImpl = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
      const dispatched = jest.fn();
      const completed = jest.fn();
      await expect(
        clientWith(fetchImpl).classifyWithLifecycle('Привет', controller.signal, {
          beforeDispatch: async () => {
            if (gate === 'pin') throw new CommercialLlmError('ABORTED');
            controller.abort();
          },
          dispatched,
          completed,
        }),
      ).rejects.toMatchObject({ kind: 'ABORTED' });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(dispatched).not.toHaveBeenCalled();
      expect(completed).not.toHaveBeenCalled();
    }
  });

  it.each(['timeout', 'invalid'] as const)(
    'does not manufacture completion on %s',
    async (failure) => {
      const dispatched = jest.fn();
      const completed = jest.fn();
      const fetchImpl: typeof fetch =
        failure === 'timeout'
          ? async () => new Promise<Response>(() => undefined)
          : async () => jsonResponse({});
      await expect(
        clientWith(fetchImpl, 10).classifyWithLifecycle('Привет', undefined, {
          beforeDispatch: async () => {},
          dispatched,
          completed,
        }),
      ).rejects.toBeInstanceOf(CommercialLlmError);
      expect(dispatched).toHaveBeenCalledTimes(1);
      expect(completed).not.toHaveBeenCalled();
    },
  );
});
