import { pathToFileURL } from 'node:url';
import { parseLegacyColdHostRequest, runLegacyColdHost } from './legacy-cold-host.mjs';
import { assertSourceAbandonmentPreflightCompletion } from './source-abandonment-preflight-completion.mjs';

export const SOURCE_ABANDONMENT_PROTOCOL = 'source-abandonment-v1';

// FLAG: Source abandonment has its own bounded request domain. Legacy entrypoints
// never accept this selection; both domains retain the same exclusive cold journal.
export function parseSourceAbandonmentHostRequest(text, now = Date.now()) {
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error('host_request_budget');
  const input = JSON.parse(text);
  if (!['preflight', 'prepare'].includes(input?.operation)) return parseLegacyColdHostRequest(text);
  const selection = input.selection;
  if (!selection || typeof selection !== 'object' || Array.isArray(selection))
    throw new Error('source_selection_required');
  const { protocol, abandonBefore, ...legacySelection } = selection;
  if (
    protocol !== SOURCE_ABANDONMENT_PROTOCOL ||
    typeof abandonBefore !== 'string' ||
    !Number.isFinite(Date.parse(abandonBefore)) ||
    new Date(abandonBefore).toISOString() !== abandonBefore ||
    Date.parse(abandonBefore) > now
  )
    throw new Error('source_cutoff_required');
  const result = parseLegacyColdHostRequest(
    JSON.stringify({ ...input, selection: legacySelection }),
  );
  if (result.selection.ownerWebhookEventIds.length > 8) throw new Error('source_selection_budget');
  return { ...result, selection: { ...result.selection, protocol, abandonBefore } };
}

export async function runSourceAbandonmentHost(request) {
  request = parseSourceAbandonmentHostRequest(JSON.stringify(request));
  return runLegacyColdHost(request, { protocol: SOURCE_ABANDONMENT_PROTOCOL });
}

export async function runSourceAbandonmentHostCli({
  args = process.argv.slice(2),
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  runHost = runSourceAbandonmentHost,
  confirmCompletion = assertSourceAbandonmentPreflightCompletion,
} = {}) {
  let text = '';
  const timer = setTimeout(() => input.destroy(new Error('stdin_deadline')), 5_000);
  try {
    if (args.length !== 0 && (args.length !== 1 || args[0] !== '--supervised-preflight'))
      throw new Error('stdin_only');
    for await (const part of input) {
      text += part;
      if (Buffer.byteLength(text) > 64 * 1024) throw new Error('stdin_budget');
    }
    clearTimeout(timer);
    const request = parseSourceAbandonmentHostRequest(text);
    const result = await runHost(request);
    let status = result.decision === 'DENY' ? 1 : 0;
    if (args[0] === '--supervised-preflight' && request.operation === 'preflight' && status === 1) {
      await confirmCompletion(request, result);
      status = 3;
    }
    output.write(`${JSON.stringify(result)}\n`);
    return status;
  } catch {
    errorOutput.write(
      'Exact-source abandonment refused; inspect its private evidence and durable journal.\n',
    );
    return 1;
  } finally {
    clearTimeout(timer);
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  process.exitCode = await runSourceAbandonmentHostCli();
