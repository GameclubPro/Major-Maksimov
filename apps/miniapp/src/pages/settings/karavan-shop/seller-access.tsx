import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { canShareNativeContent, shareNativeContent } from '../../../lib/max-bridge';
import { MutationFailure, useShop, useShopMutation } from './runtime';
import { sellerApplicationUrl } from './shop-journey';
import { useSellerPlacementLink } from './storefront-management';

function useSellerAccessState() {
  const { module } = useShop();
  const market = module.marketplace!;
  const allowed = module.permissions.includes('manage_marketplace') && market.status !== 'archived';
  const mode = market.admissionMode ?? market.admissionPolicy;
  const invitation = mode === 'invitation';
  const publicUrl = sellerApplicationUrl(module.sellerBotUrl, market.id);
  const [link, setLink] = useState<{ id: string; url: string | null; expiresAt: number } | null>(
    null,
  );
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [sharing, setSharing] = useState(false);
  const epoch = useRef(0);
  const mutation = useShopMutation({ owner: 'seller-invitation', page: 'settings' });
  const clear = () => {
    epoch.current++;
    setLink(null);
    setRevealed(false);
    setCopied(false);
    setCopyError(false);
    setSharing(false);
  };
  useEffect(() => {
    clear();
    mutation.reset();
    return () => {
      epoch.current++;
    };
  }, [allowed, invitation, market.id]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [copied]);
  useEffect(() => {
    const response = mutation.receipt?.response;
    if (
      !allowed ||
      !invitation ||
      !mutation.isSuccess ||
      response?.operation !== 'invitation_create'
    )
      return;
    setLink({
      id: response.data.id,
      url: response.data.url,
      expiresAt: Date.parse(response.data.expiresAt),
    });
    setRevealed(true);
  }, [allowed, invitation, mutation.isSuccess, mutation.receipt]);
  const url = invitation ? (link?.url ?? null) : publicUrl;
  const share = async (copyOnly = false) => {
    if (!allowed || mutation.blocked || sharing) return;
    const current = ++epoch.current;
    setSharing(true);
    setCopied(false);
    setCopyError(false);
    setRevealed(true);
    let copying = false;
    try {
      let target = url;
      if (invitation && (!link || link.expiresAt <= Date.now())) {
        const commandId = crypto.randomUUID();
        const result = await mutation.mutateAsync({
          operation: 'invitation_create',
          input: {
            commandId,
            expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
            maxUses: 1000,
            targetMaxUserId: null,
          },
        });
        if (current !== epoch.current || !result || !('url' in result)) return;
        target = result.url;
      }
      if (!target || current !== epoch.current) return;
      if (!copyOnly && canShareNativeContent()) {
        try {
          await shareNativeContent({ link: target, preferMax: true });
          return;
        } catch {
          // FLAG: Recheck the access context below before falling back to the clipboard.
        }
      }
      if (current !== epoch.current) return;
      copying = true;
      await navigator.clipboard.writeText(target);
      if (current === epoch.current) setCopied(true);
    } catch {
      if (current === epoch.current && copying) setCopyError(true);
    } finally {
      if (current === epoch.current) setSharing(false);
    }
  };
  return {
    allowed,
    invitation,
    link,
    url,
    revealed,
    copied,
    copyError,
    sharing,
    mutation,
    share,
    clear,
  };
}
const SellerAccessContext = createContext<ReturnType<typeof useSellerAccessState> | null>(null);
export function SellerAccessProvider({ children }: { children: ReactNode }) {
  return (
    <SellerAccessContext.Provider value={useSellerAccessState()}>
      {children}
    </SellerAccessContext.Provider>
  );
}
export function useSellerAccess() {
  const value = useContext(SellerAccessContext);
  if (!value) throw new Error('Missing seller access');
  return value;
}
export function AddOwnOfferAction({
  primary = false,
  storeId,
}: {
  primary?: boolean;
  storeId?: string;
}) {
  const { module } = useShop();
  const target = module.marketplace;
  const link = useSellerPlacementLink(Boolean(target && target.status !== 'archived'));
  if (!target || target.format !== 'community' || target.status === 'archived') return null;
  return (
    <>
      <button
        type="button"
        className={primary ? 'karavan-module__primary' : undefined}
        disabled={link.disabled}
        onClick={() => void link.open()}
      >
        {link.opening
          ? 'Открываем…'
          : storeId
            ? 'Управлять своим размещением'
            : 'Добавить свой товар или услугу'}
      </button>
      {link.error ? <p role="alert">{link.error}</p> : null}
    </>
  );
}
export function SellerAccessAction({ primary = false }: { primary?: boolean }) {
  const access = useSellerAccess();
  const { module } = useShop();
  const simple = (module.chatShopFlowVersion ?? 1) >= 2;
  if (!access.allowed) return null;
  const disabled =
    access.sharing ||
    access.mutation.blocked ||
    (access.invitation ? !!access.link && !access.url : !access.url);
  return (
    <div className="karavan-module__actions karavan-shop__seller-access">
      <button
        type="button"
        className={primary ? 'karavan-module__primary' : undefined}
        disabled={disabled}
        onClick={() => void access.share()}
      >
        {access.sharing
          ? 'Готовим ссылку…'
          : simple && !access.invitation
            ? 'Пригласить продавцов'
            : access.invitation
              ? 'Пригласить продавца'
              : 'Ссылка для продавцов'}
      </button>
      <MutationFailure mutation={access.mutation} />
      {access.copied ? <p role="status">Ссылка скопирована</p> : null}
      {access.revealed && access.url ? (
        <>
          {!simple ? (
            <label className="karavan-module__field">
              Ссылка для продавцов
              <input
                readOnly
                value={access.url}
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
          ) : null}
          {canShareNativeContent() ? (
            <button type="button" disabled={disabled} onClick={() => void access.share(true)}>
              Скопировать ссылку
            </button>
          ) : null}
          {access.invitation && access.link ? (
            <p>
              До{' '}
              {new Date(access.link.expiresAt).toLocaleString('ru-RU', {
                day: 'numeric',
                month: 'long',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </p>
          ) : null}
        </>
      ) : null}
      {access.copyError ? (
        <p role="alert">
          {simple
            ? 'Не удалось скопировать ссылку. Повторите.'
            : 'Не удалось скопировать. Нажмите на ссылку и выберите «Копировать».'}
        </p>
      ) : null}
      {access.invitation && access.link && !access.url ? (
        <p role="alert">Ссылка не сохранилась. Отзовите это приглашение и создайте новое.</p>
      ) : null}
      {!access.invitation && !access.url ? (
        <p role="status">Ссылка для продавцов пока недоступна.</p>
      ) : null}
    </div>
  );
}
