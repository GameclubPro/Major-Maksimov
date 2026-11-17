export type PublicMaxChannelProof = { url: string; channelId: number };

const MAX_BYTES = 64 * 1024;
const MAX_ACTIVE_REQUESTS = 2;
let activeRequests = 0;

export async function resolvePublicMaxHandle(
  url: string,
  timeoutMs: number,
): Promise<PublicMaxChannelProof | null> {
  // FLAG: Fetch only MAX's fixed public origin, without bot credentials or redirects.
  // The bot /chats API does not resolve arbitrary public names (404); never infer
  // a channel from that failure, visible text, HTML labels or an untyped profile.
  if (
    !/^https:\/\/max\.ru\/[a-z0-9_][a-z0-9_-]{0,63}$/u.test(url) ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    activeRequests >= MAX_ACTIVE_REQUESTS
  )
    return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(2_000, timeoutMs));
  activeRequests += 1;
  try {
    const response = await fetch(`${url}/__data.json`, {
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (
      !response.ok ||
      !/^application\/json(?:;|$)/iu.test(response.headers.get('content-type') ?? '') ||
      Number(response.headers.get('content-length') ?? 0) > MAX_BYTES ||
      !response.body
    )
      return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BYTES) return null;
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (controller.signal.aborted) return null;
    return parsePublicMaxChannelData(JSON.parse(Buffer.concat(chunks).toString('utf8')), url);
  } catch {
    return null;
  } finally {
    controller.abort();
    clearTimeout(timer);
    activeRequests -= 1;
  }
}

export function parsePublicMaxChannelData(
  value: unknown,
  expectedUrl: string,
): PublicMaxChannelProof | null {
  const envelope = record(value);
  if (envelope?.type !== 'data' || !Array.isArray(envelope.nodes) || envelope.nodes.length > 16)
    return null;
  const proofs: PublicMaxChannelProof[] = [];
  for (const raw of envelope.nodes) {
    const node = record(raw);
    if (node?.type !== 'data' || !Array.isArray(node.data) || node.data.length > 4_096) continue;
    const table: unknown[] = node.data;
    const root = record(table[0]);
    if (!root) continue;
    // FLAG: Read only bounded devalue references for canonical -> linkInfo.channel.
    // Never evaluate the page's JavaScript or search descriptions for type-like text.
    const canonical = dereference(table, root.canonical);
    const info = record(dereference(table, root.linkInfo));
    if (
      canonical !== expectedUrl ||
      !info ||
      Object.keys(info).length !== 1 ||
      !Object.hasOwn(info, 'channel')
    )
      continue;
    const channel = record(dereference(table, info.channel));
    const channelId = channel && dereference(table, channel.channelId);
    if (typeof channelId !== 'number' || !Number.isSafeInteger(channelId) || channelId <= 0)
      continue;
    proofs.push({ url: canonical, channelId });
  }
  return proofs.length === 1 ? proofs[0]! : null;
}

function dereference(table: unknown[], index: unknown): unknown {
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < table.length
    ? table[index]
    : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
