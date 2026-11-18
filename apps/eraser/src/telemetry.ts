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
export type TransportMetrics = {
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
  response(purpose: HttpPurpose, status: number): void {
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
