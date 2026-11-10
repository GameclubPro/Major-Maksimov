import { commercialLlmHasPinnedServerIdentity } from './commercial-llm-enforcement.protocol';
import type { CommercialLlmSecondaryScheduler } from './commercial-llm-secondary-scheduler';
import type { CommercialLlmPreviewMailbox } from './commercial-llm-preview.mailbox';
import {
  sanitizeCommercialCorpusText,
  hasResidualCommercialContactCandidate,
} from '../../scripts/commercial-corpus-sanitization.util';

// FLAG: Diagnostic inference has no intent writer, source proof or moderation effects.
export async function processCommercialLlmPreview(
  mailbox: CommercialLlmPreviewMailbox,
  task: NonNullable<Awaited<ReturnType<CommercialLlmPreviewMailbox['take']>>>,
  secondary: Pick<CommercialLlmSecondaryScheduler, 'classifyAudit'>,
  mayRun: () => Promise<boolean>,
  shutdown: AbortSignal,
): Promise<void> {
  const { raw, request } = task;
  let result = null;
  try {
    if (
      request.deadlineAtMs <= Date.now() ||
      sanitizeCommercialCorpusText(request.excerpt) !== request.excerpt ||
      hasResidualCommercialContactCandidate(request.excerpt)
    )
      return;
    // FLAG: The caller deadline revokes the result, not an already dispatched computation.
    // Drain its bounded terminal response under the client's existing timeout; aborting on
    // diagnostic expiry would leave the shared CPU quarantined after a slow cold prompt.
    const valid = async () =>
      !shutdown.aborted && (await mailbox.current(raw, request)) && (await mayRun());
    if (!(await valid())) return;
    const response = await secondary.classifyAudit(
      request.excerpt,
      shutdown,
      valid,
      request.deadlineAtMs,
    );
    if (commercialLlmHasPinnedServerIdentity(response) && (await valid())) result = response;
  } catch {
    // FLAG: Failure stays unavailable. The scheduler alone owns physical CPU uncertainty.
  } finally {
    await mailbox.finish(raw, request, result).catch(() => undefined);
  }
}
