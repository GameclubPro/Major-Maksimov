import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RUNTIME_OVERVIEW_READER_USER } from './runtime-overview-reader.guard';

@Injectable()
export class SafetyDeskAdminGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const host = this.normalizeHost(this.readHeader(request.headers.host));

    if (this.isProduction()) {
      const forwardedHost = this.normalizeHost(
        this.readHeader(request.headers['x-forwarded-host']),
      );
      const remoteUser = this.readHeader(request.headers['x-remote-user'])?.trim() ?? '';

      // FLAG: The observation-only nginx identity must never acquire owner API access.
      if (
        remoteUser &&
        remoteUser !== RUNTIME_OVERVIEW_READER_USER &&
        host &&
        forwardedHost &&
        host === forwardedHost &&
        this.isAllowedHost(host) &&
        this.isAllowedAdminRequestOrigin(request.headers)
      ) {
        return true;
      }

      throw new ForbiddenException('Safety Desk доступен только через закрытый admin-хост.');
    }

    if (host && this.isAllowedHost(host)) {
      return true;
    }

    throw new ForbiddenException('Safety Desk доступен только через закрытый admin-хост.');
  }

  private isAllowedAdminRequestOrigin(
    headers: Record<string, string | string[] | undefined>,
  ): boolean {
    const fetchSite = this.readHeader(headers['sec-fetch-site'])?.trim().toLowerCase() ?? '';

    if (fetchSite === 'cross-site') {
      return false;
    }

    const origin = this.readHeader(headers.origin)?.trim();
    if (!origin) {
      return true;
    }

    const originHost = this.normalizeOriginHost(origin);
    if (!originHost) {
      return false;
    }

    return this.isAllowedHost(originHost);
  }

  private isAllowedHost(value: string): boolean {
    const hostname = this.normalizeHost(value);
    const configuredHosts = this.configService.get<string>('SAFETY_DESK_ALLOWED_HOSTS');
    const fallbackHosts = this.isProduction()
      ? 'admin.major-maksimov.ru'
      : 'admin.major-maksimov.ru,localhost,127.0.0.1,0.0.0.0,::1';
    const allowedHosts = new Set(
      (configuredHosts?.trim() ? configuredHosts : fallbackHosts)
        .split(',')
        .map((host) => this.normalizeHost(host))
        .filter(Boolean),
    );

    if (allowedHosts.has(hostname)) {
      return true;
    }

    return false;
  }

  private isProduction(): boolean {
    return this.configService.get<string>('NODE_ENV') === 'production';
  }

  private readHeader(value: string | string[] | undefined): string | null {
    if (Array.isArray(value)) {
      return value[0] ?? null;
    }

    return value ?? null;
  }

  private normalizeOriginHost(value: string): string {
    try {
      const url = new URL(value);

      if (this.isProduction() && url.protocol !== 'https:') {
        return '';
      }

      return this.normalizeHost(url.host);
    } catch {
      return '';
    }
  }

  private normalizeHost(value: string | null): string {
    const candidate = value?.split(',')[0]?.trim().toLowerCase() ?? '';

    if (!candidate) {
      return '';
    }

    if (candidate.startsWith('[')) {
      const bracketEnd = candidate.indexOf(']');
      return bracketEnd > 0 ? candidate.slice(1, bracketEnd) : candidate;
    }

    const colonCount = (candidate.match(/:/g) ?? []).length;
    if (colonCount === 1) {
      return candidate.split(':')[0] ?? '';
    }

    return candidate;
  }
}
