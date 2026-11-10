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
    const signal = AbortSignal.any([
      shutdown,
      AbortSignal.timeout(request.deadlineAtMs - Date.now()),
    ]);
    const valid = async () =>
      !signal.aborted && (await mailbox.current(raw, request)) && (await mayRun());
    if (!(await valid())) return;
    const response = await secondary.classifyAudit(
      request.excerpt,
      signal,
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
