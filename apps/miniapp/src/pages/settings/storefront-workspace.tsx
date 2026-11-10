import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { SettingsSectionIcon } from '../../components/ui/settings-section-toggle';

const pages = {
  home: 'Магазин чата',
  catalog: 'Товары и услуги',
  applications: 'Заявки',
  categories: 'Категории и правила',
  chats: 'Подключённые чаты',
  publications: 'Объявления в чате',
  settings: 'Настройки',
  seller_access: 'Добавить продавца',
} as const;
type ActiveStorefrontPage = keyof typeof pages;
// FLAG: Legacy journals retain this page alongside the original command and media.
// Navigation resolves it to settings; retiring the screen must not discard an unknown result.
export type StorefrontPage = ActiveStorefrontPage | 'appearance';
type Navigation = {
  page: StorefrontPage;
  visited: ReadonlySet<StorefrontPage>;
  navigate: (page: StorefrontPage) => void;
  reportDirty: (page: string, dirty: boolean) => void;
  setBack: (handler: (() => void) | null) => void;
  footerTarget: HTMLDivElement | null;
  setInlinePublications: (open: boolean) => void;
};
const WorkspaceContext = createContext<Navigation | null>(null);
export function useStorefrontWorkspace() {
  return useContext(WorkspaceContext);
}
export function useStorefrontDirty(page: string, dirty: boolean) {
  const report = useStorefrontWorkspace()?.reportDirty;
  useEffect(() => {
    report?.(page, dirty);
    return () => report?.(page, false);
  }, [page, dirty, report]);
}
export function useStorefrontBack(handler: () => void, enabled = true) {
  const setBack = useStorefrontWorkspace()?.setBack;
  const current = useRef(handler);
  current.current = handler;
  useLayoutEffect(() => {
    if (!enabled || !setBack) return;
    setBack(() => current.current());
    return () => setBack(null);
  }, [setBack, enabled]);
}

/** Keep visited editors mounted so internal Back preserves drafts and query state. */
export function StorefrontScreen({
  page,
  children,
}: {
  page: StorefrontPage;
  children: ReactNode;
}) {
  const workspace = useStorefrontWorkspace();
  if (workspace && !workspace.visited.has(page)) return null;
  return (
    <div data-storefront-screen={page} hidden={!!workspace && workspace.page !== page}>
      {children}
    </div>
  );
}

export function StorefrontActions({
  page,
  children,
}: {
  page: StorefrontPage;
  children: ReactNode;
}) {
  const workspace = useStorefrontWorkspace();
  if (!workspace) return <div className="storefront-workspace__actions">{children}</div>;
  if (workspace.page !== page || !workspace.footerTarget) return null;
  return createPortal(
    <div className="storefront-workspace__actions">{children}</div>,
    workspace.footerTarget,
  );
}

export function StorefrontWorkspace({
  open,
  onClose,
  dirty = false,
  onDiscard,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  dirty?: boolean;
  onDiscard?: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const [page, setPage] = useState<ActiveStorefrontPage>('home');
  const [publicationsParent, setPublicationsParent] = useState<'home' | 'settings'>('home');
  const [visited, setVisited] = useState<ReadonlySet<StorefrontPage>>(() => new Set(['home']));
  const [drafts, setDrafts] = useState<Record<string, boolean>>({});
  const [footerTarget, setFooterTarget] = useState<HTMLDivElement | null>(null);
  const [customBack, setCustomBack] = useState<(() => void) | null>(null);
  const [inlinePublications, setInlinePublications] = useState(false);
  const setBack = useCallback((handler: (() => void) | null) => setCustomBack(() => handler), []);
  const positions = useRef(new Map<StorefrontPage, number>());
  const body = () =>
    document
      .getElementById('settings-storefront-content-title')
      ?.closest('.settings-drilldown__panel')
      ?.querySelector<HTMLElement>('.settings-drilldown__body');
  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const revealFocusedField = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          const container = body();
          const focused = document.activeElement;
          if (
            !(focused instanceof HTMLElement) ||
            !container?.contains(focused) ||
            !focused.matches('input, textarea, [contenteditable="true"]')
          )
            return;
          const field = focused.getBoundingClientRect();
          const visible = container.getBoundingClientRect();
          if (field.bottom > visible.bottom || field.top < visible.top)
            focused.scrollIntoView({ block: 'nearest' });
        });
      });
    };
    window.visualViewport?.addEventListener('resize', revealFocusedField);
    return () => {
      cancelAnimationFrame(frame);
      window.visualViewport?.removeEventListener('resize', revealFocusedField);
    };
  }, [open]);
  const navigate = useCallback(
    (next: StorefrontPage) => {
      const destination = next === 'appearance' ? 'settings' : next;
      positions.current.set(page, body()?.scrollTop ?? 0);
      if (destination === 'publications')
        setPublicationsParent(page === 'settings' ? 'settings' : 'home');
      setVisited((value) => (value.has(destination) ? value : new Set([...value, destination])));
      setPage(destination);
    },
    [page],
  );
  const reportDirty = useCallback((key: string, value: boolean) => {
    setDrafts((current) =>
      Boolean(current[key]) === value ? current : { ...current, [key]: value },
    );
  }, []);
  useLayoutEffect(() => {
    const container = body();
    if (container) container.scrollTop = positions.current.get(page) ?? 0;
    const heading = document.getElementById('settings-storefront-content-title');
    heading?.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true });
  }, [page]);
  useEffect(() => {
    if (open) return;
    setPage('home');
    setPublicationsParent('home');
    setVisited(new Set(['home']));
    setDrafts({});
    setInlinePublications(false);
    positions.current.clear();
  }, [open]);
  const context = useMemo(
    () => ({ page, visited, navigate, reportDirty, footerTarget, setBack, setInlinePublications }),
    [page, visited, navigate, reportDirty, footerTarget, setBack],
  );
  const parent =
    page === 'publications'
      ? publicationsParent
      : ['categories', 'chats'].includes(page)
        ? 'settings'
        : 'home';
  const goBack = customBack ?? (page !== 'home' ? () => navigate(parent) : undefined);
  return (
    <WorkspaceContext.Provider value={context}>
      <SettingsDrilldownPanel
        id="settings-storefront-content"
        open={open}
        title={pages[page]}
        variant="screen"
        icon={<SettingsSectionIcon name="storefront" />}
        tone="sky"
        className="settings-storefront-panel storefront-workspace"
        onClose={onClose}
        onBack={goBack}
        confirmCloseWhen={dirty || Object.values(drafts).some(Boolean)}
        onDiscardChanges={onDiscard}
        headerAction={
          goBack ? (
            <button
              type="button"
              className="storefront-workspace__back"
              aria-label="Назад"
              onClick={goBack}
            >
              ←
            </button>
          ) : null
        }
        keepFooterVisibleWhenKeyboardOpen
        footer={
          <div className="storefront-workspace__footer" ref={setFooterTarget}>
            {(page === 'publications' || (page === 'home' && inlinePublications)) && dirty
              ? footer
              : null}
          </div>
        }
      >
        {open ? children : null}
      </SettingsDrilldownPanel>
    </WorkspaceContext.Provider>
  );
}
