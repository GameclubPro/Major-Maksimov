import { readJsonResponse } from './api-response';

export type AdminApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminApiResponseParser<T> = {
  parse(value: unknown): T;
};

export type AdminApiRequestOptions = {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
  cache?: 'no-store';
};

export type AdminApiTransport = {
  request<T>(
    path: string,
    parser: AdminApiResponseParser<T>,
    options?: AdminApiRequestOptions,
  ): Promise<T>;
};

export function createAdminRequestHeaders(
  options: { json?: boolean } = {},
): Record<string, string> {
  return {
    Accept: 'application/json',
    ...(options.json ? { 'Content-Type': 'application/json' } : {}),
  };
}

export function createAdminApiTransport(
  fetchImpl: AdminApiFetch = (input, init) => globalThis.fetch(input, init),
): AdminApiTransport {
  return {
    async request<T>(
      path: string,
      parser: AdminApiResponseParser<T>,
      options: AdminApiRequestOptions = {},
    ): Promise<T> {
      const hasJsonBody = options.body !== undefined;
      const response = await fetchImpl(path, {
        ...(options.method && options.method !== 'GET' ? { method: options.method } : {}),
        credentials: 'same-origin',
        headers: createAdminRequestHeaders({ json: hasJsonBody }),
        ...(hasJsonBody ? { body: JSON.stringify(options.body) } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.cache ? { cache: options.cache } : {}),
      });

      return parser.parse(await readJsonResponse(response));
    },
  };
}
