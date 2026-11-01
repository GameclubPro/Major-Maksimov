import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  karavanMarketplaceSetupSchema,
  karavanMarketplaceCategories,
  type KaravanMarketplaceSetup,
} from '@maxim/contracts/karavan-marketplace';
import type { ApiTransport } from '../../lib/api/transport';
import {
  getAvailableKaravanMarketplaces,
  getKaravanMarketplaceSetupOptions,
  previewKaravanMarketplace,
} from '../../lib/api/karavan-marketplace-client';
import { saveMirroredItem } from '../../lib/native-storage';
import { describeUserFacingError } from '../../lib/user-facing-error';
import { openMaxBotLink } from '../../lib/max-bridge';
import {
  StorefrontActions,
  useStorefrontBack,
  useStorefrontWorkspace,
} from './storefront-workspace';
import { changedMarketplaceSetupReview } from './karavan-marketplace-setup-review';
import {
  restoreShopSetupDraft,
  shopSetupChangeRequiresAcceptance,
  shopSetupDraftKey,
  type ShopSetupDraft,
  type ShopSetupIntent,
} from './karavan-shop/setup-intent';
import { readShopDraftRecovery } from './karavan-shop/setup-recovery';
import { ShopFormatPicker, shopFormatLabel } from './karavan-shop/format-picker';

const defaultRules =
  'Продавец отвечает за описание, актуальность предложений и выполнение договорённостей. Размещение витрин — после проверки администратора. Запрещены товары и услуги, нарушающие закон и правила MAX.';
export default function KaravanMarketplaceWizard({
  api,
  chatId,
  chatTitle,
  actorId,
  intent,
  onSubmit,
  onCancel,
  sellerBotUrl,
}: {
  api: ApiTransport;
  chatId: string;
  chatTitle: string;
  actorId: string;
  intent: ShopSetupIntent;
  onSubmit: (input: KaravanMarketplaceSetup) => void;
  onCancel?: () => void;
  sellerBotUrl?: string;
}) {
  const storageKey = shopSetupDraftKey(actorId, chatId, intent);
  const creating = intent.kind === 'create';
  const choosingMarketplace = intent.kind === 'connect_existing' || intent.kind === 'replace';
  const freshDraft = (): ShopSetupDraft => ({
    mode: creating ? 'new' : 'existing',
    existingId: intent.kind === 'add_chats' ? intent.marketplaceId : null,
    format: creating ? null : 'community',
    administrationStoreId: null,
    name: chatTitle.slice(0, 120),
    rules: defaultRules,
    categories: [],
    subcategories: [],
    initialized: false,
    admissionPolicy: 'applications',
    chatIds: [chatId],
  });
  const [draft, setDraft] = useState<ShopSetupDraft>(freshDraft);
  const [hydrated, setHydrated] = useState(false);
  const [draftRecoveryError, setDraftRecoveryError] = useState(false);
  const [draftRecoveryAttempt, setDraftRecoveryAttempt] = useState(0);
  const [checking, setChecking] = useState(false);
  const submitting = useRef(false);
  const rulesDetails = useRef<HTMLDetailsElement>(null);
  const [showChats, setShowChats] = useState(intent.kind === 'add_chats');
  const [chatSearch, setChatSearch] = useState('');
  const [visibleChats, setVisibleChats] = useState(20);
  const [notice, setNotice] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const creatingStore = creating && draft.format === 'storefront' && !draft.administrationStoreId;
  const options = useQuery({
    queryKey: ['karavan-setup-options', actorId, chatId],
    queryFn: ({ signal }) => getKaravanMarketplaceSetupOptions(api, chatId, signal),
    retry: false,
  });
  const administrationSupported =
    Array.isArray(options.data?.administrationStores) &&
    typeof options.data?.sellerTermsAccepted === 'boolean';
  const administrationUnavailable = Boolean(options.data && !administrationSupported);
  const available = useInfiniteQuery({
    queryKey: ['karavan-available', actorId, chatId],
    enabled: choosingMarketplace,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => getAvailableKaravanMarketplaces(api, chatId, pageParam),
    getNextPageParam: (page) => page.nextCursor,
    retry: false,
  });
  const chats = useQuery({
    queryKey: ['karavan-setup-chats', actorId],
    enabled: showChats,
    queryFn: async () => (await import('../../lib/api/root-client')).getChats(api),
    staleTime: 30_000,
    retry: false,
  });
  const previewInput = {
    chatIds: intent.kind === 'add_chats' ? draft.chatIds : [chatId],
    marketplaceId: creating
      ? null
      : intent.kind === 'add_chats'
        ? intent.marketplaceId
        : draft.existingId,
  };
  const preview = useQuery({
    queryKey: ['karavan-setup-preview', actorId, chatId, previewInput],
    enabled: hydrated && (creating ? !!draft.format : !!previewInput.marketplaceId),
    queryFn: () => previewKaravanMarketplace(api, chatId, previewInput),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const previousReview = useRef<typeof preview.data>(undefined);
  useEffect(() => {
    if (
      preview.data &&
      previousReview.current &&
      changedMarketplaceSetupReview(previousReview.current, preview.data)
    )
      setAccepted(false);
    previousReview.current = preview.data;
  }, [preview.data]);
  useEffect(() => {
    let active = true;
    setHydrated(false);
    setDraftRecoveryError(false);
    void readShopDraftRecovery(actorId, chatId, intent)
      .then((state) => {
        if (!active) return;
        if (state.status === 'error') {
          setDraftRecoveryError(true);
          return;
        }
        // FLAG: Existing drafts predate the format choice and remain community shops.
        // Only a newly started draft asks for a format; recovery cannot change its intent.
        if (state.draft)
          setDraft({
            ...state.draft,
            format: state.draft.format === undefined ? 'community' : state.draft.format,
          });
        setHydrated(true);
      })
      .catch(() => {
        if (active) setDraftRecoveryError(true);
      });
    return () => {
      active = false;
    };
  }, [storageKey, actorId, chatId, draftRecoveryAttempt]);
  useEffect(() => {
    if (!creating || !hydrated || draft.initialized || !options.data) return;
    setDraft((value) => ({
      ...value,
      name: value.name || options.data.chatTitle.slice(0, 120),
      categories: options.data.categories.map((item) => item.id),
      subcategories: options.data.categories.flatMap((item) =>
        item.subcategories.map((sub) => sub.id),
      ),
      initialized: true,
    }));
  }, [creating, hydrated, draft.initialized, options.data]);
  useEffect(() => {
    if (hydrated) saveMirroredItem(storageKey, JSON.stringify(draft));
  }, [draft, hydrated, storageKey]);
  const change = (patch: Partial<ShopSetupDraft>) => {
    setDraft((value) => ({ ...value, ...patch }));
    setNotice(null);
    if (shopSetupChangeRequiresAcceptance(patch)) setAccepted(false);
  };
  const back = () => {
    if (checking || preview.isFetching) return false;
    onCancel?.();
    return true;
  };
  const workspace = useStorefrontWorkspace();
  useStorefrontBack(back, !!onCancel && workspace?.page !== 'publications');
  async function submit() {
    if (
      !preview.data ||
      !accepted ||
      submitting.current ||
      (creating && !draft.format) ||
      (creating && draft.format === 'storefront' && !administrationSupported) ||
      (creatingStore && options.data?.sellerTermsAccepted !== true)
    )
      return;
    setNotice(null);
    if (!restoreShopSetupDraft(JSON.stringify(draft), chatId, intent)) {
      setNotice('Настройки не соответствуют выбранному действию. Откройте его заново.');
      return;
    }
    if (intent.kind === 'add_chats' && draft.chatIds.length < 2) {
      setNotice('Выберите хотя бы один дополнительный чат.');
      return;
    }
    if (
      creating &&
      (!draft.name.trim() ||
        !draft.rules.trim() ||
        draft.categories.length === 0 ||
        !options.data ||
        draft.categories.some(
          (id) =>
            !options.data.categories.some(
              (category) =>
                category.id === id &&
                (id === 'real_estate' ||
                  category.subcategories.some((sub) => draft.subcategories.includes(sub.id))),
            ),
        ))
    ) {
      if (rulesDetails.current) rulesDetails.current.open = true;
      setNotice(
        'Укажите название и правила. Выберите хотя бы одно направление в каждой категории.',
      );
      return;
    }
    submitting.current = true;
    setChecking(true);
    try {
      const reviewed = preview.data;
      const refreshed = await preview.refetch();
      if (refreshed.isError || !refreshed.data) throw refreshed.error;
      const latest = refreshed.data;
      const changed = changedMarketplaceSetupReview(reviewed, latest);
      if (changed) {
        setAccepted(false);
        setNotice(
          changed === 'rules'
            ? 'Правила изменились. Проверьте их ещё раз.'
            : 'Подключения изменились. Проверьте выбранные чаты ещё раз.',
        );
        return;
      }
      const parsed = karavanMarketplaceSetupSchema.safeParse({
        operationId: crypto.randomUUID(),
        chatIds: previewInput.chatIds,
        ...(creating
          ? {
              create: {
                name: draft.name,
                format: draft.format ?? 'community',
                ...(draft.format === 'storefront'
                  ? { administrationStoreId: draft.administrationStoreId ?? null }
                  : {}),
                admissionPolicy: draft.admissionPolicy,
                rules: {
                  text: draft.rules,
                  allowedCategoryIds: draft.categories,
                  allowedSubcategoryIds: draft.subcategories.filter((id) =>
                    options.data?.categories.some(
                      (category) =>
                        draft.categories.includes(category.id) &&
                        category.subcategories.some((sub) => sub.id === id),
                    ),
                  ),
                  categoryOrder: draft.categories,
                },
              },
            }
          : {
              existingMarketplaceId: previewInput.marketplaceId,
              expectedPolicyRevision: latest.target?.marketplace.policyRevision,
            }),
        bindingExpectations: latest.chats.map((chat) => ({
          chatId: chat.chatId,
          generation: chat.binding?.generation ?? null,
          action: !chat.binding
            ? 'bind_chat'
            : chat.marketplace?.id === previewInput.marketplaceId && !creating
              ? chat.binding.state === 'verified'
                ? 'bind_chat'
                : 'recover_chat'
              : 'transfer_chat',
        })),
      });
      if (!parsed.success) {
        setNotice('Проверьте настройки и повторите проверку подключений.');
        return;
      }
      // FLAG: The parent persists the immutable submitted command before any request.
      onSubmit(parsed.data);
    } catch (error) {
      setNotice(
        describeUserFacingError(error, 'Не удалось проверить подключение. Повторите попытку.'),
      );
    } finally {
      submitting.current = false;
      setChecking(false);
    }
  }
  const target = preview.data?.target;
  const eligible =
    available.data?.pages
      .flatMap((page) => page.marketplaces)
      .filter(
        (item) =>
          item.marketplace.status !== 'archived' &&
          (intent.kind !== 'replace' || item.marketplace.id !== intent.previousMarketplaceId) &&
          (item.permissions.includes('bind_chat') ||
            item.permissions.includes('manage_network') ||
            item.permissions.includes('manage_marketplace')),
      ) ?? [];
  const matchingChats =
    chats.data?.filter(
      (chat) =>
        chat.id !== chatId &&
        chat.title.toLocaleLowerCase('ru').includes(chatSearch.toLocaleLowerCase('ru')),
    ) ?? [];
  if (draftRecoveryError)
    return (
      <div className="karavan-module__wizard">
        <p role="alert">
          Не удалось восстановить сохранённые настройки. Повторите проверку. Если ошибка останется,
          обратитесь в поддержку.
        </p>
        <button type="button" onClick={() => setDraftRecoveryAttempt((attempt) => attempt + 1)}>
          Повторить проверку настроек
        </button>
        <p>Можно начать заново. Сохранённый ввод будет заменён.</p>
        <button
          type="button"
          onClick={() => {
            setDraft(freshDraft());
            setAccepted(false);
            setDraftRecoveryError(false);
            setHydrated(true);
          }}
        >
          Начать без черновика
        </button>
        {onCancel ? (
          <button type="button" onClick={back}>
            Отмена
          </button>
        ) : null}
      </div>
    );
  if (!hydrated)
    return (
      <div className="karavan-module__wizard" role="status">
        Проверяем сохранённые настройки…
      </div>
    );
  if (creating && !draft.format)
    return (
      <div className="karavan-module__wizard karavan-shop-format-intro">
        <div>
          <span className="karavan-shop-format-intro__eyebrow">Магазин вашего чата</span>
          <h3>Каким будет ваш магазин?</h3>
        </div>
        <ShopFormatPicker
          value={null}
          onChange={(format) => change({ format })}
          storefrontDisabled={administrationUnavailable}
        />
        {administrationUnavailable ? (
          <div role="status">
            <p>Настройка витрины пока недоступна.</p>
            <button type="button" onClick={() => void options.refetch()}>
              Проверить снова
            </button>
          </div>
        ) : null}
        {onCancel ? (
          <StorefrontActions page={workspace?.page === 'chats' ? 'chats' : 'home'}>
            <button type="button" onClick={back}>
              Отмена
            </button>
          </StorefrontActions>
        ) : null}
      </div>
    );
  return (
    <div className="karavan-module__wizard">
      {creating && draft.format ? (
        <div className="karavan-shop-format-summary">
          <strong>{shopFormatLabel(draft.format)}</strong>
          <button type="button" disabled={checking} onClick={() => change({ format: null })}>
            Изменить формат
          </button>
        </div>
      ) : null}
      {notice ? (
        <p role="alert" className="karavan-module__notice">
          {notice}
        </p>
      ) : null}
      <fieldset
        className="karavan-module__wizard-fields"
        disabled={!hydrated || preview.isFetching || checking}
      >
        {choosingMarketplace ? (
          <fieldset className="karavan-module__choices">
            <legend>Доступные магазины</legend>
            {available.isPending ? (
              <p>Загружаем магазины…</p>
            ) : available.isError ? (
              <>
                <p role="alert">Не удалось загрузить магазины.</p>
                <button type="button" onClick={() => void available.refetch()}>
                  Повторить
                </button>
              </>
            ) : eligible.length === 0 ? (
              <p>Нет доступных магазинов.</p>
            ) : (
              eligible.map((item) => (
                <label key={item.marketplace.id}>
                  <input
                    type="radio"
                    name="karavan-existing"
                    checked={draft.existingId === item.marketplace.id}
                    onChange={() => change({ existingId: item.marketplace.id })}
                  />
                  {item.marketplace.name}
                </label>
              ))
            )}
            {available.hasNextPage ? (
              <button
                type="button"
                disabled={available.isFetchingNextPage}
                onClick={() => void available.fetchNextPage()}
              >
                Показать ещё
              </button>
            ) : null}
          </fieldset>
        ) : null}
        {creating ? (
          <>
            <label className="karavan-module__field">
              <span>
                {draft.format === 'storefront' ? 'Название витрины' : 'Название магазина'}
              </span>
              <input
                value={draft.name}
                maxLength={120}
                onChange={(event) => change({ name: event.target.value })}
              />
            </label>
            {options.isPending ? (
              <p role="status">Загружаем категории…</p>
            ) : options.isError ? (
              <div role="alert">
                <p>Не удалось загрузить категории.</p>
                <button type="button" onClick={() => void options.refetch()}>
                  Повторить
                </button>
              </div>
            ) : null}
            {draft.format === 'storefront' && administrationUnavailable ? (
              <div role="status">
                <p>Настройка витрины пока недоступна.</p>
                <button type="button" onClick={() => void options.refetch()}>
                  Проверить снова
                </button>
              </div>
            ) : draft.format === 'storefront' ? (
              <fieldset className="karavan-module__choices">
                <legend>Витрина администрации</legend>
                <label>
                  <input
                    type="radio"
                    name="administration-store"
                    checked={!draft.administrationStoreId}
                    onChange={() => change({ administrationStoreId: null })}
                  />
                  Создать новую витрину
                </label>
                {options.data?.administrationStores?.map((store) => (
                  <label key={store.id}>
                    <input
                      type="radio"
                      name="administration-store"
                      checked={draft.administrationStoreId === store.id}
                      onChange={() => change({ administrationStoreId: store.id })}
                    />
                    {store.name}
                  </label>
                ))}
              </fieldset>
            ) : (
              <details className="karavan-module__setup-rules">
                <summary>
                  Продавцы:{' '}
                  {draft.admissionPolicy === 'applications' ? 'все желающие' : 'по приглашению'}
                </summary>
                <fieldset className="karavan-module__choices">
                  <legend>Кто может подать заявку</legend>
                  <label>
                    <input
                      type="radio"
                      name="karavan-admission"
                      checked={draft.admissionPolicy === 'applications'}
                      onChange={() => change({ admissionPolicy: 'applications' })}
                    />
                    Все желающие
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="karavan-admission"
                      checked={draft.admissionPolicy === 'invitation'}
                      onChange={() => change({ admissionPolicy: 'invitation' })}
                    />
                    По приглашению
                  </label>
                </fieldset>
              </details>
            )}
            {creatingStore &&
            administrationSupported &&
            options.data?.sellerTermsAccepted === false ? (
              <div className="karavan-module__notice" role="status">
                <p>Примите условия продавца в Караване, чтобы создать витрину.</p>
                {sellerBotUrl ? (
                  <button type="button" onClick={() => openMaxBotLink(sellerBotUrl)}>
                    Открыть Караван
                  </button>
                ) : null}
                <button type="button" onClick={() => void options.refetch()}>
                  Проверить снова
                </button>
              </div>
            ) : null}
            {draft.format === 'community' ? (
              <p>Витрины появляются после вашего одобрения.</p>
            ) : null}
            <details ref={rulesDetails} className="karavan-module__setup-rules">
              <summary>Категории и правила</summary>
              {options.data ? (
                <fieldset className="karavan-module__choices">
                  <legend>Разрешённые категории</legend>
                  {options.data?.categories.map((category) => (
                    <div key={category.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={draft.categories.includes(category.id)}
                          onChange={(event) =>
                            change({
                              categories: event.target.checked
                                ? [...draft.categories, category.id]
                                : draft.categories.filter((id) => id !== category.id),
                              subcategories: event.target.checked
                                ? [
                                    ...new Set([
                                      ...draft.subcategories,
                                      ...category.subcategories.map((sub) => sub.id),
                                    ]),
                                  ]
                                : draft.subcategories.filter(
                                    (id) => !category.subcategories.some((sub) => sub.id === id),
                                  ),
                            })
                          }
                        />
                        {category.label}
                      </label>
                      {category.id !== 'real_estate' &&
                      draft.categories.includes(category.id) &&
                      category.subcategories.length ? (
                        <details className="karavan-module__subcategories">
                          <summary>
                            Направления ·{' '}
                            {
                              category.subcategories.filter((sub) =>
                                draft.subcategories.includes(sub.id),
                              ).length
                            }{' '}
                            из {category.subcategories.length}
                          </summary>
                          {category.subcategories.map((sub) => (
                            <label key={sub.id}>
                              <input
                                type="checkbox"
                                checked={draft.subcategories.includes(sub.id)}
                                onChange={(event) =>
                                  change({
                                    subcategories: event.target.checked
                                      ? [...draft.subcategories, sub.id]
                                      : draft.subcategories.filter((id) => id !== sub.id),
                                  })
                                }
                              />
                              {sub.label}
                            </label>
                          ))}
                        </details>
                      ) : null}
                    </div>
                  ))}
                </fieldset>
              ) : null}
              <label className="karavan-module__field">
                <span>
                  {draft.format === 'storefront' ? 'Правила размещения' : 'Правила для продавцов'}
                </span>
                <textarea
                  rows={5}
                  maxLength={12000}
                  value={draft.rules}
                  onChange={(event) => change({ rules: event.target.value })}
                />
              </label>
            </details>
          </>
        ) : previewInput.marketplaceId ? (
          target ? (
            <>
              <strong>{target.marketplace.name}</strong>
              <p>
                Витрины: {target.counts.listings} · Чаты: {target.counts.chats}
              </p>
              <p>
                {target.marketplace.admissionPolicy === 'invitation'
                  ? 'Приём витрин: по приглашению'
                  : 'Приём витрин: все желающие'}
              </p>
              <p>
                {target.rules.allowedCategoryIds
                  .map(
                    (id) =>
                      options.data?.categories.find((category) => category.id === id)?.label ??
                      karavanMarketplaceCategories.find(([categoryId]) => categoryId === id)?.[1],
                  )
                  .join(', ')}
              </p>
              {options.isError ? (
                <button type="button" onClick={() => void options.refetch()}>
                  Повторить загрузку категорий
                </button>
              ) : null}
              <p className="karavan-module__rules">{target.rules.text}</p>
            </>
          ) : null
        ) : null}
        {intent.kind === 'add_chats' ? (
          <details
            className="karavan-module__setup-chats"
            open={showChats}
            onToggle={(event) => setShowChats(event.currentTarget.open)}
          >
            <summary>
              {draft.chatIds.length > 1 ? `Чаты магазина · ${draft.chatIds.length}` : 'Другие чаты'}
            </summary>
            <fieldset className="karavan-module__choices">
              <legend>Чаты магазина</legend>
              <p className="karavan-module__selected-chat">
                {chatTitle || options.data?.chatTitle || 'Текущий чат'}
              </p>
              <p>Общие продавцы, правила и порядок витрин.</p>
              <label className="karavan-module__field">
                <span>Найти чат</span>
                <input
                  value={chatSearch}
                  onChange={(event) => {
                    setChatSearch(event.target.value);
                    setVisibleChats(20);
                  }}
                />
              </label>
              {chats.isPending ? (
                <p>Загружаем чаты…</p>
              ) : chats.isError ? (
                <>
                  <p role="alert">Не удалось загрузить чаты.</p>
                  <button type="button" onClick={() => void chats.refetch()}>
                    Повторить
                  </button>
                </>
              ) : (
                matchingChats.slice(0, visibleChats).map((chat) => (
                  <label key={chat.id}>
                    <input
                      type="checkbox"
                      checked={draft.chatIds.includes(chat.id)}
                      disabled={draft.chatIds.length >= 20 && !draft.chatIds.includes(chat.id)}
                      onChange={(event) =>
                        change({
                          chatIds: event.target.checked
                            ? [...draft.chatIds, chat.id]
                            : draft.chatIds.filter((id) => id !== chat.id),
                        })
                      }
                    />
                    {chat.title}
                  </label>
                ))
              )}
              {!chats.isPending && !chats.isError && matchingChats.length === 0 ? (
                <p>Других подходящих чатов нет.</p>
              ) : null}
              {matchingChats.length > visibleChats ? (
                <button type="button" onClick={() => setVisibleChats((value) => value + 20)}>
                  Показать ещё чаты
                </button>
              ) : null}
              {draft.chatIds.length === 20 ? (
                <p>За одно подключение можно выбрать до 20 чатов.</p>
              ) : null}
            </fieldset>
          </details>
        ) : null}
        {preview.isError ? (
          <div className="karavan-module__notice" role="alert">
            <p>{describeUserFacingError(preview.error, 'Не удалось проверить подключение.')}</p>
            <button type="button" onClick={() => void preview.refetch()}>
              Повторить
            </button>
          </div>
        ) : preview.isFetching ? (
          <p role="status">Проверяем подключение…</p>
        ) : null}
        {preview.data && (creating || target) ? (
          <>
            <p>
              {creating
                ? 'Покупателям магазин пока недоступен.'
                : 'Подключаемые чаты получат витрины и правила этого магазина.'}
            </p>
            {preview.data.chats.length > 1 ||
            preview.data.chats.some(
              (chat) => chat.binding && chat.marketplace?.id !== draft.existingId,
            ) ? (
              <ul className="karavan-module__progress">
                {preview.data.chats.map((chat) => (
                  <li key={chat.chatId}>
                    <span>
                      {chat.title || 'Выбранный чат'}
                      {chat.binding && chat.marketplace?.id !== draft.existingId ? (
                        <small>
                          Прежний магазин отключится. Его продавцы и заказы не переносятся.
                        </small>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <fieldset className="karavan-module__choices">
              <label>
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(event) => setAccepted(event.target.checked)}
                />
                {draft.format === 'storefront'
                  ? 'Подтверждаю подключение витрины и правила размещения'
                  : 'Подтверждаю выбранные чаты и правила магазина'}
              </label>
            </fieldset>
          </>
        ) : null}
        <StorefrontActions page={workspace?.page === 'chats' ? 'chats' : 'home'}>
          <button
            type="button"
            className="karavan-module__primary"
            disabled={
              !hydrated ||
              checking ||
              preview.isFetching ||
              !accepted ||
              !preview.data ||
              preview.isError ||
              (!creating && (!previewInput.marketplaceId || !target)) ||
              (creating && !options.data) ||
              (creating && draft.format === 'storefront' && !administrationSupported) ||
              (creatingStore && options.data?.sellerTermsAccepted !== true) ||
              (intent.kind === 'add_chats' && draft.chatIds.length < 2)
            }
            onClick={() => void submit()}
          >
            {checking || preview.isFetching
              ? 'Проверяем…'
              : creating
                ? draft.format === 'storefront'
                  ? 'Создать витрину чата'
                  : 'Создать магазин'
                : intent.kind === 'add_chats'
                  ? 'Подключить чаты'
                  : intent.kind === 'replace'
                    ? 'Заменить магазин'
                    : 'Подключить'}
          </button>
          {onCancel ? (
            <button type="button" disabled={checking || preview.isFetching} onClick={back}>
              Отмена
            </button>
          ) : null}
        </StorefrontActions>
      </fieldset>
    </div>
  );
}
