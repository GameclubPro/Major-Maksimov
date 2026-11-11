import { AppIcon as IconoirSprite } from './ui/app-icon';
import {
  MAX_PUBLISHER_AUTO_REPLY_PREVIEW_MESSAGE_LENGTH,
  type PublisherAutoReplyMatchKind,
  type PublisherAutoReplyPreviewResponse,
} from '@maxim/contracts/publisher-auto-replies';
import { useMutation } from '@tanstack/react-query';

import { useMemo, useRef, useState } from 'react';
import { previewPublisherAutoReplyMatch } from '../lib/api/publisher-auto-replies-client';
import type { ApiTransport } from '../lib/api/transport';
import { cn } from '../lib/cn';
import { describeUserFacingError } from '../lib/user-facing-error';
import {
  mergeAutoReplyPhrases,
  normalizeAutoReplyPhrase,
  validateAutoReplyTriggerDraft,
  type AutoReplyDraft,
  type AutoReplyDraftIssues,
} from '../pages/publisher-auto-replies-page-model';
import { Spinner } from './ui/spinner';

type TriggerIssues = Pick<AutoReplyDraftIssues, 'phrases' | 'fuzzyMatch'>;

export type AutoReplyMatchTesterProps = {
  api: ApiTransport;
  chatId: string;
  ruleId?: string;
  draft: AutoReplyDraft;
  pendingPhrase: string;
  disabled: boolean;
  onCommitPhrases: (phrases: string[]) => void;
  onTriggerIssues: (issues: TriggerIssues) => void;
};

function getMatchKindLabel(kind: PublisherAutoReplyMatchKind): string {
  if (kind === 'exact_context') return 'точная фраза в сообщении';
  if (kind === 'fuzzy_full') return 'сообщение целиком, с учётом опечаток';
  if (kind === 'fuzzy_context') return 'фраза в сообщении, с учётом опечаток';
  return 'точное совпадение сообщения';
}

function MatchFeedback({ result }: { result: PublisherAutoReplyPreviewResponse }) {
  if (result.outcome === 'ambiguous') {
    return (
      <div className="publisher-auto-reply-editor__preview-result is-ambiguous" role="status">
        <IconoirSprite variant="iconoir" icon="WarningCircle" aria-hidden />
        <span>
          <strong>Неоднозначное совпадение</strong>
          <small>Сообщение подходит нескольким правилам.</small>
        </span>
      </div>
    );
  }

  if (result.outcome === 'no_match' || !result.selected) {
    return (
      <div className="publisher-auto-reply-editor__preview-result is-empty" role="status">
        <IconoirSprite variant="iconoir" icon="Xmark" aria-hidden />
        <span>
          <strong>Совпадения нет</strong>
          <small>Ни одно правило не выбрано.</small>
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'publisher-auto-reply-editor__preview-result',
        result.selected.matchedDraft ? 'is-matched' : 'is-other',
      )}
      role="status"
    >
      {result.selected.matchedDraft ? (
        <IconoirSprite variant="iconoir" icon="CheckCircle" aria-hidden />
      ) : (
        <IconoirSprite variant="iconoir" icon="WarningCircle" aria-hidden />
      )}
      <span>
        <strong>
          {result.selected.matchedDraft ? 'Сработает это правило' : 'Сработает другое правило'}
        </strong>
        <small>
          «{result.selected.phrase}» · {getMatchKindLabel(result.selected.matchKind)}
        </small>
      </span>
    </div>
  );
}

export function AutoReplyMatchTester({
  api,
  chatId,
  ruleId,
  draft,
  pendingPhrase,
  disabled,
  onCommitPhrases,
  onTriggerIssues,
}: AutoReplyMatchTesterProps) {
  const [message, setMessage] = useState('');
  const [resultState, setResultState] = useState<{
    requestKey: string;
    result: PublisherAutoReplyPreviewResponse;
  } | null>(null);
  const [issueState, setIssueState] = useState<{ requestKey: string; message: string } | null>(
    null,
  );
  const requestRevisionRef = useRef(0);

  const resolved = useMemo<{ draft: AutoReplyDraft; issue?: string; commit?: boolean }>(() => {
    const pending = normalizeAutoReplyPhrase(pendingPhrase);
    if (!pending) return { draft };
    const merged = mergeAutoReplyPhrases(draft.phrases, [pending]);
    return merged.issue
      ? { draft, issue: merged.issue }
      : { draft: { ...draft, phrases: merged.phrases }, commit: true };
  }, [draft, pendingPhrase]);
  const triggerSignature = JSON.stringify([
    chatId,
    ruleId ?? null,
    resolved.draft.phrases,
    resolved.draft.matchInContext,
    resolved.draft.fuzzyMatch,
    resolved.draft.enabled,
    resolved.issue ?? null,
  ]);
  const requestKey = JSON.stringify([triggerSignature, message.trim()]);
  const latestRequestKeyRef = useRef(requestKey);
  latestRequestKeyRef.current = requestKey;

  const previewMutation = useMutation({
    mutationFn: ({
      value,
      message,
    }: {
      value: AutoReplyDraft;
      message: string;
      requestKey: string;
      revision: number;
    }) =>
      previewPublisherAutoReplyMatch(api, chatId, {
        message,
        draft: {
          ...(ruleId ? { ruleId } : {}),
          phrases: value.phrases,
          matchInContext: value.matchInContext,
          fuzzyMatch: value.fuzzyMatch,
          enabled: value.enabled,
        },
      }),
    onSuccess: (result, variables) => {
      if (
        variables.requestKey !== latestRequestKeyRef.current ||
        variables.revision !== requestRevisionRef.current
      ) {
        return;
      }
      setIssueState(null);
      setResultState({ requestKey: variables.requestKey, result });
    },
    onError: (error, variables) => {
      if (
        variables.requestKey !== latestRequestKeyRef.current ||
        variables.revision !== requestRevisionRef.current
      ) {
        return;
      }
      setResultState(null);
      setIssueState({
        requestKey: variables.requestKey,
        message: describeUserFacingError(error, 'Не удалось проверить совпадение.'),
      });
    },
  });

  const runPreview = () => {
    if (resolved.issue) {
      onTriggerIssues({ phrases: resolved.issue, fuzzyMatch: undefined });
      return;
    }
    const triggerIssues = validateAutoReplyTriggerDraft(resolved.draft);
    onTriggerIssues({
      phrases: triggerIssues.phrases,
      fuzzyMatch: triggerIssues.fuzzyMatch,
    });
    if (triggerIssues.phrases || triggerIssues.fuzzyMatch) return;
    if (!message.trim()) {
      setResultState(null);
      setIssueState({ requestKey, message: 'Введите пример сообщения.' });
      return;
    }
    if (resolved.commit) onCommitPhrases(resolved.draft.phrases);
    const revision = requestRevisionRef.current + 1;
    requestRevisionRef.current = revision;
    setResultState(null);
    setIssueState(null);
    previewMutation.mutate({
      value: resolved.draft,
      message: message.trim(),
      requestKey,
      revision,
    });
  };

  const issue = issueState?.requestKey === requestKey ? issueState.message : null;
  const result = resultState?.requestKey === requestKey ? resultState.result : null;

  return (
    <details className="publisher-auto-reply-editor__tester">
      <summary>Проверить совпадение</summary>
      <div className="publisher-auto-reply-editor__tester-row">
        <input
          id="publisher-auto-reply-preview-message"
          value={message}
          maxLength={MAX_PUBLISHER_AUTO_REPLY_PREVIEW_MESSAGE_LENGTH}
          disabled={disabled || previewMutation.isPending}
          placeholder="Сообщение участника"
          aria-label="Сообщение участника"
          enterKeyHint="go"
          aria-describedby={issue ? 'publisher-auto-reply-preview-error' : undefined}
          aria-invalid={Boolean(issue)}
          onChange={(event) => {
            requestRevisionRef.current += 1;
            setMessage(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              runPreview();
            }
          }}
        />
        <button
          type="button"
          disabled={disabled || previewMutation.isPending || !message.trim()}
          onClick={runPreview}
        >
          {previewMutation.isPending ? (
            <Spinner size="sm" label={null} />
          ) : (
            <IconoirSprite variant="iconoir" icon="Play" aria-hidden />
          )}
          <span>Проверить</span>
        </button>
      </div>
      {issue ? (
        <small id="publisher-auto-reply-preview-error" role="alert">
          {issue}
        </small>
      ) : null}
      {result ? <MatchFeedback result={result} /> : null}
    </details>
  );
}
