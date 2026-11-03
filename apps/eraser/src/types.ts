export type Hours = 24 | 48 | 168;
export type Lane = 'live' | 'history';
export type Message = {
  id: string;
  chatId: string;
  authorId: string;
  isBot: boolean | null;
  sourceMs: number;
};
export type Policy = {
  chat_id: string;
  enabled: boolean;
  hours: Hours;
  revision: number;
  activation_id: string;
  enabled_at: Date | null;
  first_enabled_at: Date | null;
  next_run_at: Date;
  live_floor: string | null;
  live_upper: string | null;
  live_cursor: string | null;
  history_cursor: string | null;
  history_complete: boolean;
  history_gap: boolean;
  scanned_count: string;
  deleted_count: string;
  deleted_historical_unknown_count: string;
  deleted_acknowledged_count: string;
  deleted_removal_receipt_count: string;
  skipped_count: string;
  connection_status: 'connected' | 'missing' | 'no_access' | 'unknown';
  connection_generation: string;
  last_error: string | null;
  lease_until: Date | null;
  updated_at: Date;
  lease_token: string | null;
};
export type Candidate = {
  chat_id: string;
  message_id: string;
  author_id: string;
  is_bot: boolean | null;
  source_ms: string;
  lane: Lane;
  state: string;
  attempt_count: number;
  outcome_code: string | null;
  updated_at: Date;
  next_attempt_at: Date;
  dispatch_id: string | null;
};
export type Protection = {
  sourceRevision: number;
  protectedMessageIds: string[];
  protectedBotIds: string[];
  holdMessageIds: string[];
  holdAuthorIds?: string[];
  completeThrough: string | null;
  botHistoryCompleteFrom?: string | null;
  complete?: boolean;
  evidence?: import('./protection-evidence.js').ProtectionEvidence;
};
export type UpdatePolicy = {
  enabled: boolean;
  hours: Hours;
  expectedRevision: number;
  operationId: string;
  actorUserId: string;
  connectWhenReady?: boolean;
};
export type ConnectionProof = {
  chatId: string;
  connectionGeneration: string;
  expiresAt: Date;
};
export type PolicyActivationGuard = {
  chatId: string;
  operationId: string;
  expectedRevision: number;
  connectionGeneration: string;
};
export type PolicyActivationProof = PolicyActivationGuard & { expiresAt: Date };
export type PendingConnectionRequest = ConnectionRequest & { connection_generation: string };
export type ConnectionRequest = {
  chat_id: string;
  operation_id: string;
  actor_user_id: string;
  policy_revision: number;
  status: 'pending' | 'expired' | 'cancelled' | 'activated';
  expires_at: Date;
  next_attempt_at: Date;
  lease_token: string | null;
  lease_until: Date | null;
  last_error: string | null;
  updated_at: Date;
};
export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export function validChat(chatId: string): boolean {
  return /^-[1-9]\d*$/.test(chatId);
}
export function hours(value: unknown): value is Hours {
  return value === 24 || value === 48 || value === 168;
}
export function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
export function timestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return timestamp(Number(value));
  return null;
}
export function parseMessage(raw: unknown, expectedChat: string): Message | null {
  const value = record(raw),
    body = record(value?.body),
    recipient = record(value?.recipient),
    sender = record(value?.sender);
  const sourceMs = timestamp(value?.timestamp);
  if (
    !body ||
    typeof body.mid !== 'string' ||
    !body.mid ||
    body.mid.length > 256 ||
    String(recipient?.chat_id) !== expectedChat ||
    recipient?.chat_type !== 'chat' ||
    !sender ||
    !sourceMs ||
    sourceMs > Date.now() + 60_000
  )
    return null;
  const authorId = String(sender.user_id ?? '');
  if (!/^\d+$/.test(authorId)) return null;
  return {
    id: body.mid,
    chatId: expectedChat,
    authorId,
    isBot: typeof sender.is_bot === 'boolean' ? sender.is_bot : null,
    sourceMs,
  };
}
