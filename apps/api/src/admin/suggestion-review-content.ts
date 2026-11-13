import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { SuggestionReviewWrite } from '@maxim/contracts/publisher';
import { buildPublisherSuggestionPublicationText } from './publisher-suggestion-content';
import { readChannelSuggestionTextMarkup } from './admin-channel-dialog-values';
import { renderMaxTextMarkupAsMarkdown } from '../common/max-text-markup.util';

export function suggestionRevision(payload: Record<string, unknown>): number {
  const revision = payload.reviewContentRevision;
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0
    ? revision
    : 0;
}

export function suggestionEditorText(payload: Record<string, unknown>): string {
  const text = typeof payload.text === 'string' ? payload.text : '';
  const markup = readChannelSuggestionTextMarkup(payload.textMarkup);
  const raw = payload.textMarkup;
  if (
    (raw != null && !Array.isArray(raw)) ||
    (Array.isArray(raw) && raw.length !== markup.length) ||
    markup.some(
      (item) =>
        !Number.isSafeInteger(item.from) ||
        !Number.isSafeInteger(item.length) ||
        item.from < 0 ||
        item.from + item.length > text.length ||
        (item.type === 'link' && !safeEditorUrl(item.url)) ||
        (item.type === 'user_mention' && !safeEditorUrl(item.userLink)),
    )
  )
    throw new BadRequestException(
      'Не удалось безопасно прочитать оформление. Исходный пост сохранён без изменений.',
    );
  if (markup.length) return renderMaxTextMarkupAsMarkdown(text, markup) ?? text;
  return payload.textFormat === 'markdown' ? text : text.replace(/([\\`*_[\]()~+#^>])/gu, '\\$1');
}

export function suggestionContentPatch(
  payload: Record<string, unknown>,
  input: SuggestionReviewWrite,
  actorId: string,
): Record<string, unknown> {
  if (suggestionRevision(payload) !== input.expectedRevision)
    throw new ConflictException('Предложку уже изменили. Обновите её перед сохранением.');
  if (input.text === undefined || input.text === suggestionEditorText(payload)) return {};
  const patch = {
    reviewOriginalContent: payload.reviewOriginalContent ?? {
      text: typeof payload.text === 'string' ? payload.text : '',
      textFormat: payload.textFormat ?? 'plain',
      textMarkup: payload.textMarkup ?? [],
    },
    text: input.text,
    textFormat: 'markdown',
    textMarkup: [],
    reviewContentRevision: input.expectedRevision + 1,
    reviewEditedByUserId: actorId,
    reviewEditedAt: new Date().toISOString(),
  };
  return patch;
}

export function assertSuggestionPublicationLength(
  actorId: string,
  payload: Record<string, unknown>,
): void {
  if (buildPublisherSuggestionPublicationText(actorId, payload).length > 4_000) {
    throw new BadRequestException(
      'Пост вместе со ссылкой на автора превышает 4000 символов. Сократите текст.',
    );
  }
}

/** FLAG: Operation IDs bind the exact actor, action and body; retries never authorize different edits. */
export function suggestionRequestHash(action: string, actorId: string, input: object): string {
  return createHash('sha256').update(JSON.stringify({ action, actorId, input })).digest('hex');
}

export function hasSuggestionRequest(
  payload: Record<string, unknown>,
  action: string,
  actorId: string,
  input: { requestId: string },
): boolean {
  const requests = readRequests(payload);
  const prior = requests[input.requestId];
  if (!prior) return false;
  if (prior.hash !== suggestionRequestHash(action, actorId, input))
    throw new ConflictException(
      'Это действие уже использовано для другого решения. Обновите предложку.',
    );
  return true;
}

export function suggestionRequestPatch(
  payload: Record<string, unknown>,
  action: string,
  actorId: string,
  input: { requestId: string },
  revision: number,
): Record<string, unknown> {
  return {
    reviewEditorRequests: {
      ...readRequests(payload),
      [input.requestId]: {
        hash: suggestionRequestHash(action, actorId, input),
        revision,
      },
    },
  };
}

export function publicationEditorInput(
  payload: Record<string, unknown>,
  actorId: string,
  input: SuggestionReviewWrite,
): SuggestionReviewWrite {
  if (!hasSuggestionRequest(payload, 'publish', actorId, input)) return input;
  if (readRequests(payload)[input.requestId]?.revision !== suggestionRevision(payload))
    throw new ConflictException('Предложку изменили после этого решения. Обновите её.');
  return { ...input, expectedRevision: suggestionRevision(payload) };
}

function readRequests(
  payload: Record<string, unknown>,
): Record<string, { hash: string; revision: number }> {
  const value = payload.reviewEditorRequests;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, { hash: string; revision: number }>)
    : {};
}

function safeEditorUrl(value: string | null): boolean {
  if (!value) return false;
  if (/^max:\/\/user\/[1-9]\d*$/u.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}
