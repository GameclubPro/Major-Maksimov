import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  karavanMarketplaceSetupSchema,
  type KaravanMarketplaceSetup,
} from '@maxim/contracts/karavan-marketplace';
import type { ApiTransport } from '../../../lib/api/transport';
import {
  getKaravanMarketplaceSetupOptions,
  previewKaravanMarketplace,
} from '../../../lib/api/karavan-marketplace-client';
import { saveMirroredItem, writeLocalMirrorItem } from '../../../lib/native-storage';
import { describeUserFacingError } from '../../../lib/user-facing-error';
import { useStorefrontBack } from '../storefront-workspace';
import { localShopRecoveryReaders } from './storage-recovery';
import { readShopDraftRecovery } from './setup-recovery';
import { shopSetupDraftKey, type ShopSetupDraft } from './setup-intent';
import { ShopFormatPicker, type ShopFormat } from './format-picker';
import { ShopAdmissionPicker, type ShopAdmissionMode } from './admission-picker';
import { allShopCategories, ShopCategoryPicker } from './category-picker';

const intent = { kind: 'create' } as const;
const defaultRules =
  'Продавец отвечает за описание, актуальность предложений и выполнение договорённостей. Запрещены товары и услуги, нарушающие закон и правила MAX.';

export default function ShopStartup({
  api,
  chatId,
  chatTitle,
  actorId,
  onSubmit,
  localOnlyRecovery = false,
}: {
  api: ApiTransport;
  chatId: string;
  chatTitle: string;
  actorId: string;
  onSubmit: (input: KaravanMarketplaceSetup) => void;
  localOnlyRecovery?: boolean;
}) {
  const client = useQueryClient();
  const key = shopSetupDraftKey(actorId, chatId, intent);
  const fresh = (): ShopSetupDraft => ({
    mode: 'new',
    existingId: null,
    format: null,
    administrationStoreId: null,
    name: chatTitle.slice(0, 120),
    rules: defaultRules,
    categories: [],
    subcategories: [],
    initialized: false,
    admissionPolicy: 'applications',
    chatIds: [chatId],
    setupVersion: 2,
    started: false,
  });
  const [draft, setDraft] = useState(fresh);
  const [hydrated, setHydrated] = useState(false);
  const [recoveryError, setRecoveryError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [categoriesEditing, setCategoriesEditing] = useState(false);
  const submitting = useRef(false);
  const epoch = useRef(0);
  const options = useQuery({
    queryKey: ['karavan-setup-options', actorId, chatId],
    queryFn: ({ signal }) => getKaravanMarketplaceSetupOptions(api, chatId, signal),
    retry: false,
  });
  useEffect(() => {
    const current = ++epoch.current;
    setHydrated(false);
    setRecoveryError(false);
    void readShopDraftRecovery(
      actorId,
      chatId,
      intent,
      localOnlyRecovery ? localShopRecoveryReaders : undefined,
    )
      .then((state) => {
        if (current !== epoch.current) return;
        if (state.status === 'error') {
          setRecoveryError(true);
          return;
        }
        if (state.draft) {
          // FLAG: An editable legacy draft retains the user's choices. Submitted
          // commands are recovered by the parent before this startup can mount.
          setDraft({
            ...state.draft,
            setupVersion: 2,
            started: state.draft.started ?? true,
            format: state.draft.format === undefined ? 'community' : state.draft.format,
          });
        } else setDraft(fresh());
        setHydrated(true);
      })
      .catch(() => {
        if (current === epoch.current) setRecoveryError(true);
      });
    return () => {
      epoch.current++;
    };
  }, [key, actorId, chatId, attempt, localOnlyRecovery]);
  useEffect(() => {
    if (!hydrated || draft.initialized || !options.data) return;
    setDraft((current) => ({
      ...current,
      name: current.name || options.data.chatTitle.slice(0, 120),
      ...allShopCategories(options.data.categories),
      initialized: true,
    }));
  }, [hydrated, draft.initialized, options.data]);
  useEffect(() => {
    if (hydrated)
      (localOnlyRecovery ? writeLocalMirrorItem : saveMirroredItem)(key, JSON.stringify(draft));
  }, [draft, hydrated, key, localOnlyRecovery]);
  const change = (patch: Partial<ShopSetupDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setNotice(null);
  };
  useStorefrontBack(
    () => {
      if (busy) return;
      if (draft.format) change({ format: null });
      else change({ started: false });
    },
    hydrated && Boolean(draft.started),
  );
  const submit = async (format: ShopFormat) => {
    if (
      submitting.current ||
      categoriesEditing ||
      !options.data ||
      !draft.initialized ||
      !draft.categories.length
    )
      return;
    const requestEpoch = epoch.current;
    submitting.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const preview = await previewKaravanMarketplace(api, chatId, {
        chatIds: [chatId],
        marketplaceId: null,
      });
      if (requestEpoch !== epoch.current) return;
      if (preview.chats.some((chat) => chat.binding)) {
        setNotice('У этого чата уже есть магазин. Обновляем состояние.');
        await client.invalidateQueries({ queryKey: ['karavan-marketplace', chatId] });
        return;
      }
      const request = karavanMarketplaceSetupSchema.parse({
        operationId: crypto.randomUUID(),
        chatIds: [chatId],
        create: {
          setupVersion: 2,
          name: draft.name || options.data.chatTitle.slice(0, 120),
          format,
          admissionPolicy: format === 'storefront' ? 'applications' : draft.admissionPolicy,
          rules: {
            text: draft.rules,
            allowedCategoryIds: draft.categories,
            allowedSubcategoryIds: draft.subcategories,
            categoryOrder: draft.categories,
          },
        },
        bindingExpectations: [{ chatId, generation: null, action: 'bind_chat' }],
      });
      // FLAG: Parent recovery persists this exact command before its first request.
      onSubmit(request);
    } catch (error) {
      if (requestEpoch === epoch.current)
        setNotice(describeUserFacingError(error, 'Не удалось включить магазин. Повторите.'));
    } finally {
      submitting.current = false;
      if (requestEpoch === epoch.current) setBusy(false);
    }
  };
  if (recoveryError)
    return (
      <div className="karavan-module__notice" role="alert">
        <p>Не удалось восстановить настройки.</p>
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          Повторить
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(fresh());
            setRecoveryError(false);
            setHydrated(true);
          }}
        >
          Начать без черновика
        </button>
      </div>
    );
  if (!hydrated || options.isPending) return <p role="status">Проверяем настройки…</p>;
  if (!options.data)
    return (
      <div role="alert">
        <p>Не удалось загрузить настройки магазина.</p>
        <button type="button" onClick={() => void options.refetch()}>
          Повторить
        </button>
      </div>
    );
  return (
    <div className="karavan-shop-startup">
      {!draft.started ? (
        <div className="karavan-shop-startup__welcome">
          <span className="karavan-shop-startup__mark" aria-hidden="true">
            ↗
          </span>
          <h3>{options.data.chatTitle || chatTitle || 'Магазин чата'}</h3>
          <p>Товары и услуги вашего чата — в одном магазине.</p>
          <button
            type="button"
            className="karavan-module__primary"
            onClick={() => change({ started: true })}
          >
            Включить магазин
          </button>
        </div>
      ) : !draft.format ? (
        <>
          <h3>Кто будет продавать?</h3>
          <ShopFormatPicker
            simple
            value={null}
            disabled={busy || !draft.initialized}
            onChange={(format) => {
              change({ format });
              if (format === 'storefront') void submit(format);
            }}
          />
        </>
      ) : draft.format === 'community' ? (
        <>
          <ShopAdmissionPicker
            value={
              draft.admissionPolicy === 'invitation'
                ? null
                : (draft.admissionPolicy as ShopAdmissionMode)
            }
            disabled={busy}
            onChange={(admissionPolicy) => change({ admissionPolicy })}
          />
          <ShopCategoryPicker
            options={options.data.categories}
            value={draft}
            disabled={busy}
            onChange={change}
            onEditingChange={setCategoriesEditing}
          />
          <button
            type="button"
            className="karavan-module__primary"
            disabled={
              busy ||
              categoriesEditing ||
              !draft.categories.length ||
              draft.admissionPolicy === 'invitation'
            }
            onClick={() => void submit('community')}
          >
            {busy ? 'Включаем…' : 'Продолжить'}
          </button>
        </>
      ) : (
        <>
          <h3>Продаёт администрация</h3>
          {busy ? (
            <p role="status">Включаем магазин…</p>
          ) : (
            <button
              type="button"
              className="karavan-module__primary"
              onClick={() => void submit('storefront')}
            >
              Продолжить
            </button>
          )}
        </>
      )}
      {notice ? <p role="alert">{notice}</p> : null}
    </div>
  );
}
