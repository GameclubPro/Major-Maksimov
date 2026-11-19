type Row = Record<string, unknown>;

type PublicationSource =
  | { kind: 'direct'; text: string }
  | { kind: 'forward'; text: string; senderId: string | null };

export function readKaravanSourceRow(value: unknown): Row | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : undefined;
}

export function readKaravanWebhookMessage(raw: unknown): Row | undefined {
  const envelope = readKaravanSourceRow(raw);
  if (!envelope) return undefined;
  const direct = readKaravanSourceRow(envelope.message);
  if (direct) return direct;

  for (const key of ['message_created', 'data', 'event', envelope.update_type, envelope.type]) {
    if (typeof key !== 'string' || !key.trim()) continue;
    const wrapper = readKaravanSourceRow(envelope[key]);
    const message =
      readKaravanSourceRow(wrapper?.message) ??
      readKaravanSourceRow(readKaravanSourceRow(wrapper?.data)?.message);
    if (message) return message;
  }
}

/** Undefined means absent. Null means invalid or contradictory identity evidence. */
export function readKaravanSourceIdentity(...values: unknown[]): string | null | undefined {
  let identity: string | undefined;
  for (const value of values) {
    if (value == null || value === '') continue;
    const current =
      typeof value === 'string'
        ? value.trim()
        : typeof value === 'number' && Number.isSafeInteger(value)
          ? String(value)
          : null;
    if (!current || (identity !== undefined && identity !== current)) return null;
    identity = current;
  }
  return identity;
}

function readText(message: Row | undefined): string | null | undefined {
  const body = readKaravanSourceRow(message?.body);
  const aliases = [
    body?.text,
    body?.caption,
    body?.plain,
    message?.text,
    message?.caption,
    message?.plain,
    message?.message_text,
    message?.messageText,
  ];
  let text: string | undefined;
  for (const alias of aliases) {
    if (typeof alias !== 'string' || !alias.trim()) continue;
    const current = alias.trim();
    if (text !== undefined && text !== current) return null;
    text = current;
  }
  return text;
}

// FLAG: An explicit outer message owns its text, even when it contains a quoted or forwarded marker.
export function readKaravanPublicationSource(
  message: Row | undefined,
  legacyEnvelopeText?: string,
): PublicationSource | null {
  if (!message) return null;
  const direct = readText(message);
  if (direct === null) return null;
  if (direct) return { kind: 'direct', text: direct };
  if (legacyEnvelopeText) return { kind: 'direct', text: legacyEnvelopeText };

  const link = readKaravanSourceRow(message.link);
  if (typeof link?.type !== 'string' || link.type.trim().toLowerCase() !== 'forward') return null;
  const text = readText(readKaravanSourceRow(link.message));
  if (!text) return null;

  const sender = readKaravanSourceRow(link.sender);
  const senderId = readKaravanSourceIdentity(
    link.sender_id,
    link.senderId,
    sender?.user_id,
    sender?.userId,
    sender?.id,
  );
  return senderId === null ? null : { kind: 'forward', text, senderId: senderId ?? null };
}
