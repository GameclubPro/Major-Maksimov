import pino from 'pino';
import { HTTP_LOG_REDACT_PATHS } from './http-log-redaction';

describe('HTTP log redaction', () => {
  it('redacts the machine overview token from requests and nested transport failures', () => {
    const output: string[] = [];
    const logger = pino(
      { base: null, timestamp: false, redact: HTTP_LOG_REDACT_PATHS },
      {
        write: (chunk: string) => {
          output.push(chunk);
        },
      },
    );
    const token = 'machine-overview-token-must-remain-private';
    const headers = {
      'X-Runtime-Overview-Reader-Token': token,
      'x-runtime-overview-reader-token': token,
    };
    logger.info({
      req: { method: 'GET', headers: { 'x-runtime-overview-reader-token': token } },
      err: { config: { headers }, response: { config: { headers } } },
    });
    expect(output.join('')).not.toContain(token);
    expect(output.join('')).toContain('[Redacted]');
    expect(output.join('')).toContain('GET');
  });

  it('never logs preview text or encoded mutation payloads', () => {
    const output: string[] = [];
    const logger = pino(
      { base: null, timestamp: false, redact: HTTP_LOG_REDACT_PATHS },
      {
        write: (chunk: string) => {
          output.push(chunk);
        },
      },
    );
    logger.info({
      req: {
        method: 'POST',
        body: { text: 'private-preview-text' },
        query: { body: 'encoded-body', bodyGzip: 'compressed-body', chunk: 'encoded-chunk' },
      },
    });
    const serialized = output.join('');
    for (const value of [
      'private-preview-text',
      'encoded-body',
      'compressed-body',
      'encoded-chunk',
    ])
      expect(serialized).not.toContain(value);
    expect(serialized).toContain('POST');
  });
  it('redacts request credentials and signed launch payloads while preserving useful context', () => {
    const output: string[] = [];
    const logger = pino(
      {
        base: null,
        timestamp: false,
        redact: HTTP_LOG_REDACT_PATHS,
      },
      {
        write(chunk: string) {
          output.push(chunk);
        },
      },
    );

    logger.info({
      req: {
        method: 'GET',
        url: '/api/admin/dialog?token=signed-dialog-token&screen=messages',
        query: {
          token: 'signed-dialog-token',
          access_token: 'access-token',
          initData: 'signed-max-init-data',
          signature: 'request-signature',
          startapp: 'signed-miniapp-start-payload',
          start_param: 'signed-start-payload',
          screen: 'messages',
          page: '2',
        },
        headers: {
          authorization: 'InitData signed-max-init-data',
          cookie: '__Host-maxim_session=session-token',
          'x-admin-access-code': 'server-admin-code',
          'x-miniapp-csrf-token': 'csrf-token',
          referer: 'https://major-maksimov.ru/app/?startapp=signed-miniapp-start-payload',
          'user-agent': 'MAX WebView',
          'x-request-id': 'request-123',
        },
      },
      res: {
        statusCode: 200,
        headers: {
          'set-cookie': '__Host-maxim_session=session-token; Secure; HttpOnly',
        },
      },
    });

    const record = JSON.parse(output.join('')) as {
      req: {
        method: string;
        url: string;
        query: Record<string, string>;
        headers: Record<string, string>;
      };
      res: { statusCode: number; headers: Record<string, string> };
    };

    expect(record.req).toEqual({
      method: 'GET',
      url: '[Redacted]',
      query: {
        token: '[Redacted]',
        access_token: '[Redacted]',
        initData: '[Redacted]',
        signature: '[Redacted]',
        startapp: '[Redacted]',
        start_param: '[Redacted]',
        screen: 'messages',
        page: '2',
      },
      headers: {
        authorization: '[Redacted]',
        cookie: '[Redacted]',
        'x-admin-access-code': '[Redacted]',
        'x-miniapp-csrf-token': '[Redacted]',
        referer: '[Redacted]',
        'user-agent': 'MAX WebView',
        'x-request-id': 'request-123',
      },
    });
    expect(record.res).toEqual({
      statusCode: 200,
      headers: { 'set-cookie': '[Redacted]' },
    });
  });

  it.each([
    'token',
    'access_token',
    'accessToken',
    'auth',
    'authorization',
    'hash',
    'init_data',
    'initData',
    'secret',
    'signature',
    'start',
    'startapp',
    'startApp',
    'start_param',
    'startParam',
    'webAppData',
    'WebAppData',
    'webAppStartParam',
    'WebAppStartParam',
  ])('redacts the %s query key', (key) => {
    const output: string[] = [];
    const logger = pino(
      { base: null, timestamp: false, redact: HTTP_LOG_REDACT_PATHS },
      {
        write(chunk: string) {
          output.push(chunk);
        },
      },
    );

    logger.info({ req: { query: { [key]: 'credential', filter: 'active' } } });

    const record = JSON.parse(output.join('')) as {
      req: { query: Record<string, string> };
    };
    expect(record.req.query).toEqual({ [key]: '[Redacted]', filter: 'active' });
  });
});
