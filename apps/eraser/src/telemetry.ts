export const HTTP_PURPOSES = [
  'bot_rights',
  'actor_rights',
  'pin',
  'live_scan',
  'history_scan',
  'safety_rights',
  'safety_scan',
  'delete',
  'presence',
  'identity',
  'subscriptions',
] as const;
export type HttpPurpose = (typeof HTTP_PURPOSES)[number];
type RequestCounters = {
  attempts: number;
  responses: number;
  httpSuccesses: number;
  rateLimited: number;
  transportErrors: number;
};
export const RIGHTS_SOURCES = ['cleanup', 'safety', 'connection', 'settings'] as const;
export type RightsSource = (typeof RIGHTS_SOURCES)[number];
export const RIGHTS_OUTCOMES = [
  'ok',
  'unauthorized',
  'forbidden',
  'missing',
  'rateLimited',
  'other4xx',
  'serverError',
  'other',
] as const;
type RightsCounts = Record<(typeof RIGHTS_OUTCOMES)[number], number>;
function rightsCounts(): RightsCounts {
  return {
    ok: 0,
    unauthorized: 0,
    forbidden: 0,
    missing: 0,
    rateLimited: 0,
    other4xx: 0,
    serverError: 0,
    other: 0,
  };
}
function rightsOutcome(status: number): keyof RightsCounts {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'missing';
  if (status === 429) return 'rateLimited';
  if (status >= 400 && status < 500) return 'other4xx';
  if (status >= 500 && status < 600) return 'serverError';
  return 'other';
}
export type TransportMetrics = {
  rightsResponses: Array<RightsCounts & { source: RightsSource }>;
  scope: 'process';
  since: string;
  observedAt: string;
  requests: Array<RequestCounters & { purpose: HttpPurpose }>;
  cooldownDeferrals: number;
  admissionUnavailable: number;
  guardRejected: number;
  deleteAcknowledged: number;
  observedCooldownUntil: string | null;
};

// FLAG: Fixed purpose labels and scalar counters never retain paths, tokens, message IDs,
// response bodies or error text. These process observations are not durable effect receipts.
export class HttpTelemetry {
  private readonly since: string;
  private readonly rights = new Map(RIGHTS_SOURCES.map((source) => [source, rightsCounts()]));
  private readonly requests = new Map<HttpPurpose, RequestCounters>(
    HTTP_PURPOSES.map((purpose) => [
      purpose,
      { attempts: 0, responses: 0, httpSuccesses: 0, rateLimited: 0, transportErrors: 0 },
    ]),
  );
  private cooldownDeferrals = 0;
  private admissionUnavailable = 0;
  private guardRejected = 0;
  private deleteAcknowledged = 0;
  private observedCooldownUntil = 0;
  constructor(private readonly now: () => number = () => Date.now()) {
    this.since = new Date(this.now()).toISOString();
  }
  attempt(purpose: HttpPurpose): void {
    this.requests.get(purpose)!.attempts++;
  }
  response(purpose: HttpPurpose, status: number, source?: RightsSource): void {
    if (source) this.rights.get(source)![rightsOutcome(status)]++;
    const counters = this.requests.get(purpose)!;
    counters.responses++;
    if (status >= 200 && status < 300) counters.httpSuccesses++;
    if (status === 429) counters.rateLimited++;
  }
  transportError(purpose: HttpPurpose): void {
    this.requests.get(purpose)!.transportErrors++;
  }
  admission(kind: 'cooldown' | 'unavailable' | 'guard', retryAtMs?: number): void {
    if (kind === 'cooldown') {
      this.cooldownDeferrals++;
      this.cooldownUntil(retryAtMs ?? this.now() + 1000);
    } else if (kind === 'unavailable') this.admissionUnavailable++;
    else this.guardRejected++;
  }
  cooldownUntil(until: number): void {
    if (Number.isFinite(until) && until <= 8_640_000_000_000_000)
      this.observedCooldownUntil = Math.max(this.observedCooldownUntil, until);
  }
  acknowledgeDelete(): void {
    this.deleteAcknowledged++;
  }
  snapshot(): TransportMetrics {
    return {
      scope: 'process',
      rightsResponses: [...this.rights].map(([source, counts]) => ({ source, ...counts })),
      since: this.since,
      observedAt: new Date(this.now()).toISOString(),
      requests: [...this.requests].map(([purpose, counters]) => ({ purpose, ...counters })),
      cooldownDeferrals: this.cooldownDeferrals,
      admissionUnavailable: this.admissionUnavailable,
      guardRejected: this.guardRejected,
      deleteAcknowledged: this.deleteAcknowledged,
      observedCooldownUntil: this.observedCooldownUntil
        ? new Date(this.observedCooldownUntil).toISOString()
        : null,
    };
  }
}
