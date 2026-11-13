import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  buildSuggestionRejectionText,
  SUGGESTION_REJECTION_LABELS,
  SUGGESTION_REVIEW_TEXT_LIMIT,
  suggestionRejectionRequestSchema,
  suggestionReviewDetailSchema,
  type MiniappProfile,
  type SuggestionRejectionReason,
  type SuggestionReviewDetail,
} from '@maxim/contracts/publisher';
import type { ApiTransport } from '../lib/api/transport';
import { MAX_MARKDOWN_TOOL_DEFINITIONS, type MaxMarkdownTool } from '../lib/max-markdown-tools';
import {
  MaxRichTextEditor,
  type MaxRichTextEditorHandle,
} from '../components/max-rich-text-editor';
import { MaxMarkdownPreview } from '../components/max-markdown-preview';
import { closeMaxMiniApp, openMaxProfileLink } from '../lib/max-bridge';
import { useNativeBackHandler } from '../lib/native-back';
import { hydrateMirroredItem, removeMirroredItem, saveMirroredItem } from '../lib/native-storage';
import { describeUserFacingError } from '../lib/user-facing-error';
import '../styles/suggestion-review.css';

type Preview = { text: string; textFormat?: 'markdown' | 'html' | 'plain' };
const statuses = {
  pending: 'На рассмотрении',
  publishing: 'Передаём в публикацию',
  published: 'Передано в публикацию',
  drafted: 'Перенесено в черновик',
  cancelled: 'Отклонено',
};
const notificationLabels = {
  none: '',
  pending: 'Ответ ожидает отправки',
  sent: 'Ответ отправлен',
  failed: 'Не удалось отправить ответ',
  ambiguous: 'Отправка ответа не подтверждена',
};

function AssetPreview({
  api,
  suggestionId,
  asset,
}: {
  api: ApiTransport;
  suggestionId: string;
  asset: SuggestionReviewDetail['media'][number];
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!asset.available) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    void api
      .request(
        `/suggestion-reviews/${encodeURIComponent(suggestionId)}/assets/${encodeURIComponent(asset.id)}`,
        { responseType: 'blob' },
      )
      .then((blob) => {
        if (cancelled || !(blob instanceof Blob)) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => setUrl(null));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, asset.available, asset.id, suggestionId]);
  return (
    <figure className="suggestion-review__asset">
      {url ? (
        asset.type === 'image' ? (
          <img src={url} alt={asset.name} />
        ) : (
          <video src={url} controls preload="metadata" />
        )
      ) : (
        <span>
          {asset.type === 'video' ? 'Видео' : 'Фото'} · {asset.name}
        </span>
      )}
    </figure>
  );
}

function PreviewContent({ preview }: { preview: Preview }) {
  // FLAG: HTML is the authenticated server's escaped MAX presentation, never editable DOM input.
  return preview.textFormat === 'html' ? (
    <div
      className="suggestion-review__preview"
      dangerouslySetInnerHTML={{ __html: preview.text }}
    />
  ) : (
    <div className="suggestion-review__preview">
      <MaxMarkdownPreview
        value={preview.text}
        sourceFormat={preview.textFormat === 'plain' ? 'plain' : 'markdown'}
        preserveLinks
        preserveWhitespace
      />
    </div>
  );
}

type PageProps = { api: ApiTransport; profile: MiniappProfile; userId: string };

export function SuggestionReviewPage(props: PageProps) {
  const { suggestionId, mode } = useParams();
  return (
    <SuggestionReviewContent
      key={`${props.profile}:${props.userId}:${suggestionId}:${mode}`}
      {...props}
    />
  );
}

function SuggestionReviewContent({
  api,
  profile,
  userId,
}: {
  api: ApiTransport;
  profile: MiniappProfile;
  userId: string;
}) {
  const { suggestionId = '', mode = 'edit' } = useParams();
  const navigate = useNavigate();
  const path = `/suggestion-reviews/${encodeURIComponent(suggestionId)}`;
  const [detail, setDetail] = useState<SuggestionReviewDetail | null>(null);
  const [text, setText] = useState('');
  const [reason, setReason] = useState<SuggestionRejectionReason | null>(null);
  const [comment, setComment] = useState('');
  const [contactUrl, setContactUrl] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [showPreview, setShowPreview] = useState(mode === 'publish');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [ready, setReady] = useState(false);
  const [editorReady, setEditorReady] = useState(true);
  const [conflictDraft, setConflictDraft] = useState<string | null>(null);
  const editorRef = useRef<MaxRichTextEditorHandle>(null);
  const [activeTools, setActiveTools] = useState<ReadonlySet<MaxMarkdownTool>>(new Set());
  const operationRef = useRef<{ body: string; id: string } | null>(null);
  const busyRef = useRef(false);
  const storageKey = `suggestion-review-v1:${profile}:${userId}:${suggestionId}`;
  const operationKey = `${storageKey}:operation`;
  const query = useQuery({
    queryKey: ['suggestion-review', profile, userId, suggestionId],
    queryFn: async () => suggestionReviewDetailSchema.parse(await api.request(path)),
    refetchOnWindowFocus: false,
    retry: false,
  });
  useEffect(() => {
    if (!query.data) return;
    let cancelled = false;
    const current = query.data;
    setDetail(current);
    setText(current.text);
    setContactUrl(current.contactUrl);
    setPreview({ text: current.previewText, textFormat: current.previewFormat });
    void hydrateMirroredItem(storageKey).then((raw) => {
      if (cancelled) return;
      if (raw && current.status === 'pending') {
        try {
          const draft = JSON.parse(raw) as {
            text?: unknown;
            revision?: unknown;
            savedAt?: unknown;
          };
          if (
            typeof draft.text === 'string' &&
            draft.text.length <= SUGGESTION_REVIEW_TEXT_LIMIT &&
            typeof draft.savedAt === 'number' &&
            Date.now() - draft.savedAt < 72 * 60 * 60_000
          ) {
            if (draft.revision === current.revision) setText(draft.text);
            else {
              setConflictDraft(draft.text);
              setNotice('Предложку изменил другой администратор. Ваш черновик сохранён отдельно.');
            }
          }
        } catch {
          /* Invalid local draft never replaces server content. */
        }
      }
      void hydrateMirroredItem(operationKey)
        .then((saved) => {
          if (cancelled) return;
          try {
            const operation = saved ? JSON.parse(saved) : null;
            if (typeof operation?.body === 'string' && typeof operation?.id === 'string')
              operationRef.current = operation;
          } catch {
            /* Ignore invalid device storage. */
          }
          setReady(true);
        })
        .catch(() => {
          if (!cancelled) setReady(true);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [query.data, query.dataUpdatedAt, storageKey, operationKey]);
  useEffect(() => {
    if (ready && detail?.status === 'pending' && conflictDraft === null) {
      if (text === detail.text) {
        removeMirroredItem(storageKey);
        return;
      }
      saveMirroredItem(
        storageKey,
        JSON.stringify({ revision: detail.revision, text, savedAt: Date.now() }),
      );
    }
  }, [detail, ready, storageKey, text, conflictDraft]);
  const close = useCallback(() => {
    closeMaxMiniApp(() => navigate('/'));
    return true;
  }, [navigate]);
  useNativeBackHandler(close);
  useEffect(() => {
    if (!detail || !showPreview || detail.status !== 'pending') return;
    let cancelled = false;
    setPreviewBusy(true);
    setPreview(null);
    const timer = setTimeout(() => {
      void api
        .request(`${path}/preview`, {
          method: 'POST',
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            expectedRevision: detail.revision,
            text,
          }),
          retryMutationOnTransportError: false,
        })
        .then((result) => {
          if (!cancelled) {
            setPreview(result as Preview);
            setError('');
          }
        })
        .catch((failure) => {
          if (!cancelled)
            setError(describeUserFacingError(failure, 'Не удалось подготовить предпросмотр.'));
        })
        .finally(() => {
          if (!cancelled) setPreviewBusy(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, detail, path, showPreview, text]);

  async function submit(action: 'save' | 'publish' | 'reject', notifyAuthor = true) {
    if (!detail || busyRef.current) return;
    const body =
      action === 'reject'
        ? {
            expectedRevision: detail.revision,
            notifyAuthor,
            ...(reason ? { reason } : {}),
            comment,
            contactUrl: reason === 'paid' && notifyAuthor ? contactUrl : '',
          }
        : { expectedRevision: detail.revision, text };
    const signature = JSON.stringify({ action, ...body });
    if (operationRef.current?.body !== signature)
      operationRef.current = { body: signature, id: crypto.randomUUID() };
    const request = { ...body, requestId: operationRef.current.id };
    if (action === 'reject') {
      const parsed = suggestionRejectionRequestSchema.safeParse(request);
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? 'Проверьте ответ.');
        return;
      }
    }
    saveMirroredItem(operationKey, JSON.stringify(operationRef.current));
    busyRef.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = suggestionReviewDetailSchema.parse(
        await api.request(`${path}/${action}`, {
          method: 'POST',
          body: JSON.stringify(request),
          retryMutationOnTransportError: false,
        }),
      );
      setDetail(next);
      setText(next.text);
      setPreview({ text: next.previewText, textFormat: next.previewFormat });
      removeMirroredItem(storageKey);
      operationRef.current = null;
      removeMirroredItem(operationKey);
      setConflictDraft(null);
      setNotice(action === 'save' ? 'Изменения сохранены' : '');
      if (action === 'publish') setShowPreview(true);
    } catch (failure) {
      setError(
        describeUserFacingError(failure, 'Не удалось сохранить решение. Повторите попытку.'),
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function refresh() {
    const result = await query.refetch();
    if (result.isError) setError(describeUserFacingError(result.error, 'Предложка недоступна.'));
  }
  if (query.isError && !detail)
    return (
      <main className="suggestion-review">
        <p role="alert">{describeUserFacingError(query.error, 'Предложка недоступна.')}</p>
        <button className="button button--secondary" onClick={() => void refresh()}>
          Повторить
        </button>
      </main>
    );
  if (query.isPending || !ready)
    return (
      <main className="suggestion-review" aria-busy="true">
        <p>Загружаю предложку…</p>
        {query.isError ? (
          <p role="alert">{describeUserFacingError(query.error, 'Предложка недоступна.')}</p>
        ) : null}
      </main>
    );
  if (!detail)
    return (
      <main className="suggestion-review">
        <p role="alert">Предложка недоступна.</p>
      </main>
    );
  const pending = detail.status === 'pending';
  const rejection = mode === 'reject' && pending;
  const replyText = reason
    ? buildSuggestionRejectionText(reason, detail.channelTitle, comment)
    : '';
  return (
    <main className="suggestion-review">
      <header className="suggestion-review__header">
        <div>
          <span className="suggestion-review__eyebrow">{detail.channelTitle}</span>
          <h1>{rejection ? 'Отклонить предложку' : 'Предложка'}</h1>
        </div>
        <span className="suggestion-review__status">{statuses[detail.status]}</span>
      </header>
      <div className="suggestion-review__author">
        <span>Автор</span>
        {detail.author.url ? (
          <button type="button" onClick={() => openMaxProfileLink(detail.author.url!)}>
            {detail.author.name} ↗
          </button>
        ) : (
          <strong>{detail.author.name}</strong>
        )}
      </div>
      {error ? (
        <div className="suggestion-review__notice is-error" role="alert">
          {error}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void refresh();
            }}
          >
            Обновить предложку
          </button>
        </div>
      ) : null}
      {notice ? (
        <p className="suggestion-review__notice" role="status">
          {notice}
        </p>
      ) : null}
      {conflictDraft !== null ? (
        <details className="suggestion-review__original">
          <summary>Мой несохранённый текст</summary>
          <textarea aria-label="Мой несохранённый текст" readOnly value={conflictDraft} rows={6} />
          <button
            type="button"
            onClick={() => {
              setText(conflictDraft);
              setConflictDraft(null);
            }}
          >
            Использовать мой текст
          </button>
        </details>
      ) : null}
      {rejection ? (
        <>
          <div className="suggestion-review__reasons" aria-label="Причина отказа">
            {(Object.keys(SUGGESTION_REJECTION_LABELS) as SuggestionRejectionReason[]).map(
              (key) => (
                <button
                  type="button"
                  key={key}
                  aria-pressed={reason === key}
                  disabled={busy}
                  onClick={() => {
                    setReason(key);
                    setError('');
                  }}
                >
                  {SUGGESTION_REJECTION_LABELS[key]}
                </button>
              ),
            )}
          </div>
          {reason ? (
            <section className="suggestion-review__reply">
              <label>
                Пояснение <span>необязательно</span>
                <textarea
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  maxLength={500}
                  disabled={busy}
                  rows={3}
                />
              </label>
              {reason === 'paid' ? (
                <label>
                  Контакт для размещения
                  <input
                    type="url"
                    placeholder="https://max.ru/…"
                    value={contactUrl}
                    onChange={(event) => {
                      setContactUrl(event.target.value);
                      setError('');
                    }}
                    disabled={busy}
                  />
                </label>
              ) : null}
              <div className="suggestion-review__reply-preview">
                <span>Ответ автору</span>
                <p>{replyText}</p>
                {reason === 'paid' ? (
                  <span className="suggestion-review__contact-preview">
                    Связаться с администратором ↗
                  </span>
                ) : null}
              </div>
            </section>
          ) : null}
          <div className="suggestion-review__actions">
            <button
              className="button button--danger"
              type="button"
              disabled={busy || !reason}
              onClick={() => void submit('reject')}
            >
              Отклонить и отправить
            </button>
            <button
              className="button button--secondary"
              type="button"
              disabled={busy}
              onClick={() => void submit('reject', false)}
            >
              Отклонить без сообщения
            </button>
            <button type="button" disabled={busy} onClick={close}>
              Назад
            </button>
          </div>
        </>
      ) : (
        <>
          {detail.media.length ? (
            <div className="suggestion-review__media">
              {detail.media.map((asset) => (
                <AssetPreview key={asset.id} api={api} suggestionId={detail.id} asset={asset} />
              ))}
            </div>
          ) : null}
          {pending ? (
            <div className="suggestion-review__tabs">
              <button
                type="button"
                aria-pressed={!showPreview}
                onClick={() => setShowPreview(false)}
              >
                Редактировать
              </button>
              <button type="button" aria-pressed={showPreview} onClick={() => setShowPreview(true)}>
                Предпросмотр
              </button>
            </div>
          ) : null}
          {!showPreview && pending ? (
            <section className="suggestion-review__editor">
              <div className="suggestion-review__tools" aria-label="Форматирование">
                {MAX_MARKDOWN_TOOL_DEFINITIONS.map((tool) => (
                  <button
                    key={tool.id}
                    type="button"
                    title={tool.title}
                    aria-label={tool.title}
                    aria-pressed={activeTools.has(tool.id)}
                    disabled={busy || !editorReady}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => editorRef.current?.applyTool(tool.id)}
                  >
                    {tool.label}
                  </button>
                ))}
              </div>
              <MaxRichTextEditor
                ref={editorRef}
                onActiveToolsChange={setActiveTools}
                value={text}
                onChange={setText}
                maxLength={SUGGESTION_REVIEW_TEXT_LIMIT}
                ariaLabel="Текст предложки"
                placeholder="Текст публикации"
                preserveWhitespace
                disabled={busy}
                onNormalizationReadyChange={setEditorReady}
              />
            </section>
          ) : previewBusy ? (
            <p role="status">Готовлю предпросмотр…</p>
          ) : preview ? (
            <PreviewContent preview={preview} />
          ) : null}
          <details className="suggestion-review__original">
            <summary>Исходный текст</summary>
            <MaxMarkdownPreview value={detail.originalText} preserveLinks preserveWhitespace />
          </details>
          {detail.rejectionText ? (
            <div className="suggestion-review__reply-preview">
              <p>{detail.rejectionText}</p>
              <span role="status">{notificationLabels[detail.notification]}</span>
            </div>
          ) : null}
          {pending ? (
            <div className="suggestion-review__actions">
              <button
                className="button button--primary"
                type="button"
                disabled={busy || !editorReady || previewBusy}
                onClick={() => void submit('publish')}
              >
                {text === detail.text ? 'В публикацию' : 'Сохранить и в публикацию'}
              </button>
              <button
                className="button button--secondary"
                type="button"
                disabled={busy || !editorReady || text === detail.text}
                onClick={() => void submit('save')}
              >
                Сохранить
              </button>
              <button type="button" disabled={busy} onClick={close}>
                Назад
              </button>
            </div>
          ) : (
            <button
              className="button button--secondary"
              type="button"
              onClick={() => {
                void refresh();
              }}
            >
              Обновить статус
            </button>
          )}
        </>
      )}
    </main>
  );
}
