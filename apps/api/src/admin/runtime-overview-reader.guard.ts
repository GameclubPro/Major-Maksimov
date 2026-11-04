import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getAppRole } from '../runtime/app-role';

const HEX_32_BYTES = /^[a-f0-9]{64}$/u;
export const RUNTIME_OVERVIEW_READER_HEADER = 'x-runtime-overview-reader-token';
export const RUNTIME_OVERVIEW_READER_USER = 'maxim-observer';
type Headers = Record<string, string | string[] | undefined>;

function header(headers: Headers, key: string): string | null {
  const value = headers[key];
  return typeof value === 'string' ? value : null;
}

function hostname(value: string | null): string | null {
  if (!value || /[\s,/@?#\\]/u.test(value)) return null;
  try {
    return new URL(`https://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

@Injectable()
export class RuntimeOverviewReaderGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ method: string; headers: Headers }>();
    const production = this.config.get<string>('NODE_ENV') === 'production';
    const host = hostname(header(request.headers, 'host'));
    const allowedHosts = (
      this.config.get<string>('SAFETY_DESK_ALLOWED_HOSTS')?.trim() ||
      (production ? 'admin.major-maksimov.ru' : 'admin.major-maksimov.ru,localhost,127.0.0.1,[::1]')
    )
      .split(',')
      .map((value) => hostname(value.trim()));
    const digest = this.config.get<string>('RUNTIME_OVERVIEW_READER_TOKEN_SHA256');
    const token = header(request.headers, RUNTIME_OVERVIEW_READER_HEADER);
    const validToken =
      typeof digest === 'string' &&
      HEX_32_BYTES.test(digest) &&
      token !== null &&
      HEX_32_BYTES.test(token) &&
      timingSafeEqual(createHash('sha256').update(token).digest(), Buffer.from(digest, 'hex'));

    // FLAG: This credential admits one cached GET only; it never substitutes for owner or MAX auth.
    if (
      request.method !== 'GET' ||
      getAppRole() !== 'admin' ||
      !host ||
      !allowedHosts.includes(host) ||
      !validToken ||
      !this.sameOrigin(request.headers, host, production) ||
      (production &&
        (hostname(header(request.headers, 'x-forwarded-host')) !== host ||
          header(request.headers, 'x-forwarded-proto') !== 'https' ||
          header(request.headers, 'x-remote-user') !== RUNTIME_OVERVIEW_READER_USER))
    ) {
      throw new ForbiddenException('Runtime observation access denied.');
    }
    return true;
  }

  private sameOrigin(headers: Headers, host: string, production: boolean): boolean {
    const site = header(headers, 'sec-fetch-site');
    if (site?.toLowerCase() === 'cross-site') return false;
    if (headers.origin === undefined) return true;
    const origin = header(headers, 'origin');
    if (!origin) return false;
    try {
      const parsed = new URL(origin);
      return (
        ['http:', 'https:'].includes(parsed.protocol) &&
        (!production || parsed.protocol === 'https:') &&
        !parsed.username &&
        !parsed.password &&
        parsed.origin === origin &&
        parsed.hostname.toLowerCase() === host
      );
    } catch {
      return false;
    }
  }
}
