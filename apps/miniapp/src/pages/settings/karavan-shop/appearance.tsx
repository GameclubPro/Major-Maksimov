import { useEffect, useId, useRef, useState } from 'react';
import { StorefrontActions, useStorefrontDirty } from '../storefront-workspace';
import {
  marketplaceAppearanceSchema,
  type MarketplaceAppearance,
} from '@maxim/contracts/karavan-marketplace-management';
import {
  MutationFailure,
  ShopFailure,
  ShopLoading,
  useShopMutation,
  useShopQuery,
} from './runtime';
import { describeUserFacingError } from '../../../lib/user-facing-error';
import { useShopCommands } from './command-runtime';
const blockNames = { categories: 'Категории', pinned: 'Закреплённые', sellers: 'Продавцы' };
const accentNames = {
  blue: 'Синий',
  violet: 'Фиолетовый',
  teal: 'Бирюзовый',
  rose: 'Розовый',
  graphite: 'Графит',
};
async function imageData(file: File, cover: boolean): Promise<string> {
  if (!file.type.startsWith('image/') || file.size > 20 * 1024 * 1024)
    throw new Error('Выберите изображение до 20 МБ.');
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = cover ? 1200 : 320;
    canvas.height = cover ? 400 : 320;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Не удалось подготовить изображение.');
    const scale = Math.max(canvas.width / bitmap.width, canvas.height / bitmap.height);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
      bitmap,
      (canvas.width - bitmap.width * scale) / 2,
      (canvas.height - bitmap.height * scale) / 2,
      bitmap.width * scale,
      bitmap.height * scale,
    );
    const data = canvas.toDataURL('image/jpeg', 0.82).split(',')[1];
    if (!data || data.length > 700000) throw new Error('Выберите изображение меньшего размера.');
    return data;
  } finally {
    bitmap.close();
  }
}
export default function ShopAppearance({ onView }: { onView?: () => void }) {
  const errorId = useId();
  const [validationAttempt, setValidationAttempt] = useState(0);
  const nameRef = useRef<HTMLInputElement>(null);
  const blocksRef = useRef<HTMLFieldSetElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const [invalidField, setInvalidField] = useState<'name' | 'blocks' | null>(null);
  const commands = useShopCommands();
  const query = useShopQuery<'appearance'>({ operation: 'appearance' });
  const [draft, setDraft] = useState<MarketplaceAppearance | null>(null),
    [uploading, setUploading] = useState(false),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!error) return;
    const target =
      invalidField === 'name'
        ? nameRef.current
        : invalidField === 'blocks'
          ? blocksRef.current
          : errorRef.current;
    const details = target?.closest('details');
    if (details) details.open = true;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'center', behavior: 'instant' });
  }, [error, invalidField, validationAttempt]);
  const mutation = useShopMutation({ owner: 'appearance', page: 'appearance' }, (command) => {
    if (command.operation === 'appearance_apply' || command.operation === 'appearance_save')
      setDraft((current) =>
        !current || JSON.stringify(current) === JSON.stringify(command.input.appearance)
          ? null
          : current,
      );
  });
  const imageMutation = useShopMutation(
    { owner: 'appearance-image', page: 'appearance' },
    (command, data) => {
      const receipt = commands.journal?.results['appearance-image'];
      if (command.operation !== 'image' || !('url' in data) || !receipt?.ui.imageTarget) return;
      const key = receipt.ui.imageTarget;
      setDraft((current) => {
        const base = commands.journal?.appearanceDraft
          ? (current ?? commands.journal.appearanceDraft)
          : null;
        return base ? { ...base, [key]: data.url } : current;
      });
    },
  );
  const value = draft ?? commands.journal?.appearanceDraft ?? query.data?.draft;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(query.data?.draft);
  useStorefrontDirty(
    'appearance',
    dirty || uploading || mutation.uncertain || imageMutation.uncertain,
  );
  if (query.isPending) return <ShopLoading />;
  if (query.isError || !value)
    return <ShopFailure error={query.error} retry={() => void query.refetch()} />;
  const change = <K extends keyof MarketplaceAppearance>(
    key: K,
    next: MarketplaceAppearance[K],
  ) => {
    setDraft({ ...value, [key]: next });
    setError(null);
    setInvalidField(null);
  };
  const upload = async (file: File, key: 'logoImageUrl' | 'coverImageUrl') => {
    setUploading(true);
    setError(null);
    setInvalidField(null);
    let dataBase64: string;
    try {
      dataBase64 = await imageData(file, key === 'coverImageUrl');
    } catch (err) {
      setError(describeUserFacingError(err, 'Не удалось подготовить изображение.'));
      setUploading(false);
      return;
    }
    try {
      await imageMutation.mutateAsync(
        {
          operation: 'image',
          input: {
            commandId: crypto.randomUUID(),
            fileName: key === 'coverImageUrl' ? 'cover.jpg' : 'logo.jpg',
            mimeType: 'image/jpeg',
            dataBase64,
          },
        },
        { imageTarget: key, appearanceDraft: value },
      );
    } catch {
      // FLAG: Keep the original upload command when its result is unknown.
    } finally {
      setUploading(false);
    }
  };
  const save = (operation: 'appearance_apply' | 'appearance_save') => {
    const parsed = marketplaceAppearanceSchema.safeParse(value);
    if (!parsed.success) {
      setValidationAttempt((attempt) => attempt + 1);
      const field = parsed.error.issues[0]?.path[0];
      setInvalidField(field === 'name' || field === 'blocks' ? field : null);
      setError(
        field === 'name'
          ? 'Введите название магазина.'
          : field === 'blocks'
            ? 'Выберите хотя бы один раздел.'
            : 'Проверьте оформление магазина.',
      );
      return;
    }
    setError(null);
    setInvalidField(null);
    mutation.mutate(
      {
        operation,
        input: {
          commandId: crypto.randomUUID(),
          expectedRevision: query.data.revision,
          appearance: parsed.data,
        },
      },
      { appearanceDraft: parsed.data },
    );
  };
  const editingBlocked = uploading || mutation.editingBlocked || imageMutation.editingBlocked;
  const submittingBlocked = uploading || mutation.blocked || imageMutation.blocked;
  return (
    <>
      <MutationFailure mutation={mutation} />
      <MutationFailure mutation={imageMutation} />
      {error && !invalidField ? (
        <p ref={errorRef} tabIndex={-1} role="alert">
          {error}
        </p>
      ) : null}
      <fieldset className="karavan-shop__form" disabled={editingBlocked}>
        <label className="karavan-module__field">
          <span id={`${errorId}-name`}>Название</span>
          <input
            aria-labelledby={`${errorId}-name`}
            ref={nameRef}
            aria-invalid={invalidField === 'name'}
            aria-describedby={invalidField === 'name' ? errorId : undefined}
            value={value.name}
            maxLength={120}
            onChange={(event) => change('name', event.target.value)}
          />
          {invalidField === 'name' ? (
            <small id={errorId} role="alert">
              {error}
            </small>
          ) : null}
        </label>
        <div className="karavan-shop__media">
          {(['logoImageUrl', 'coverImageUrl'] as const).map((key) => (
            <div key={key} className={key === 'coverImageUrl' ? 'is-cover' : ''}>
              {value[key] ? (
                <img src={value[key]} alt={key === 'coverImageUrl' ? 'Обложка' : 'Логотип'} />
              ) : null}
              <label className="karavan-shop__upload">
                <span>{key === 'coverImageUrl' ? 'Обложка' : 'Логотип'}</span>
                <input
                  type="file"
                  accept="image/*"
                  aria-label={key === 'coverImageUrl' ? 'Загрузить обложку' : 'Загрузить логотип'}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) void upload(file, key);
                  }}
                />
              </label>
              {value[key] ? (
                <button type="button" onClick={() => change(key, null)}>
                  Убрать
                </button>
              ) : null}
            </div>
          ))}
        </div>
        <label className="karavan-module__field">
          Описание
          <textarea
            value={value.description ?? ''}
            maxLength={2000}
            onChange={(event) => change('description', event.target.value || null)}
          />
        </label>
        <details className="karavan-shop__appearance-options">
          <summary>Цвет и разделы</summary>
          <fieldset className="karavan-module__choices">
            <legend>Цвет</legend>
            <div className="karavan-shop__accents">
              {(Object.keys(accentNames) as Array<MarketplaceAppearance['accent']>).map(
                (accent) => (
                  <button
                    key={accent}
                    type="button"
                    data-accent={accent}
                    aria-pressed={value.accent === accent}
                    aria-label={accentNames[accent]}
                    onClick={() => change('accent', accent)}
                  />
                ),
              )}
            </div>
          </fieldset>
          <fieldset
            ref={blocksRef}
            tabIndex={-1}
            className="karavan-module__choices"
            aria-describedby={invalidField === 'blocks' ? errorId : undefined}
          >
            <legend>Главная магазина</legend>
            {invalidField === 'blocks' ? (
              <p id={errorId} role="alert">
                {error}
              </p>
            ) : null}
            {value.blocks.map((block, index) => (
              <div className="karavan-shop__block" key={block.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={block.visible}
                    onChange={(event) =>
                      change(
                        'blocks',
                        value.blocks.map((row) =>
                          row.id === block.id ? { ...row, visible: event.target.checked } : row,
                        ),
                      )
                    }
                  />
                  {blockNames[block.id]}
                </label>
                <button
                  type="button"
                  aria-label={`Выше: ${blockNames[block.id]}`}
                  disabled={index === 0}
                  onClick={() => {
                    const next = [...value.blocks];
                    [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                    change('blocks', next);
                  }}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Ниже: ${blockNames[block.id]}`}
                  disabled={index === value.blocks.length - 1}
                  onClick={() => {
                    const next = [...value.blocks];
                    [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
                    change('blocks', next);
                  }}
                >
                  ↓
                </button>
              </div>
            ))}
          </fieldset>
        </details>
      </fieldset>
      {uploading ? <p role="status">Загружаем изображение…</p> : null}
      <p className="karavan-shop__draft-status" role="status">
        {dirty
          ? 'Есть несохранённые изменения'
          : query.data.hasChanges
            ? 'Сохранено на потом'
            : 'Оформление сохранено'}
      </p>
      {dirty ? (
        <details className="karavan-shop__appearance-options">
          <summary>Дополнительные действия</summary>
          <button
            type="button"
            disabled={submittingBlocked}
            onClick={() => save('appearance_save')}
          >
            Сохранить на потом
          </button>
        </details>
      ) : null}
      <StorefrontActions page="appearance">
        <button
          type="button"
          className="karavan-module__primary"
          disabled={submittingBlocked || (!dirty && !query.data.hasChanges)}
          onClick={() => save('appearance_apply')}
        >
          Сохранить изменения
        </button>
        {onView ? (
          <button type="button" disabled={dirty || editingBlocked} onClick={onView}>
            Посмотреть магазин чата
          </button>
        ) : null}
      </StorefrontActions>
    </>
  );
}
