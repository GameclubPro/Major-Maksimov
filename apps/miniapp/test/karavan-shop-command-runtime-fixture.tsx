import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MarketplaceAppearance } from '@maxim/contracts/karavan-marketplace-management';
import type { ApiTransport } from '../src/lib/api/transport';
import type { ShopCommand } from '../src/lib/api/karavan-shop-client';
import {
  loadShopCommandJournal,
  type ShopJournalScope,
} from '../src/pages/settings/karavan-shop/command-journal';
import {
  ShopCommandProvider,
  ShopCommandRecovery,
  useShopCommands,
} from '../src/pages/settings/karavan-shop/command-runtime';
import {
  ShopContext,
  useShop,
  useShopMutation,
  type ShopModule,
} from '../src/pages/settings/karavan-shop/runtime';
import {
  SellerAccessAction,
  SellerAccessProvider,
  useSellerAccess,
} from '../src/pages/settings/karavan-shop/seller-access';

const originalScope: ShopJournalScope = {
  actorMaxUserId: '1001',
  chatId: '-123',
  marketplaceId: '11111111-1111-4111-8111-111111111111',
  expectedBindingGeneration: 1,
};
const otherScope: ShopJournalScope = {
  actorMaxUserId: '1002',
  chatId: '-456',
  marketplaceId: '22222222-2222-4222-8222-222222222222',
  expectedBindingGeneration: 2,
};
const originalAppearance: MarketplaceAppearance = {
  name: 'Магазин соседей',
  description: null,
  logoImageUrl: null,
  coverImageUrl: null,
  accent: 'blue',
  blocks: [
    { id: 'categories', visible: true },
    { id: 'pinned', visible: true },
    { id: 'sellers', visible: true },
  ],
};

const api: ApiTransport = {
  async request(path, init) {
    const response = await fetch(path, {
      method: init?.method,
      body: init?.body,
      signal: init?.signal,
      headers: { 'Content-Type': 'application/json' },
    });
    const result: unknown = await response.json();
    if (response.headers.get('X-Simulated-Lost-Response') === '1')
      throw new Error('Connection lost after commit');
    if (!response.ok) throw new Error(`Unexpected fixture response: ${response.status}`);
    return result;
  },
  requestKeepalive() {},
};

function moduleFor(scope: ShopJournalScope): ShopModule {
  return {
    actorMaxUserId: scope.actorMaxUserId,
    marketplace: {
      id: scope.marketplaceId,
      networkId: '33333333-3333-4333-8333-333333333333',
      publicSlug: 'command-runtime-shop',
      name: scope.chatId === originalScope.chatId ? 'Магазин соседей' : 'Другой магазин',
      description: null,
      kind: 'chat',
      status: 'active',
      admissionPolicy: 'invitation',
      logoImageUrl: null,
      coverImageUrl: null,
      editRevision: 1,
      policyRevision: 1,
      orderRevision: 1,
      visibilityRevision: 1,
    },
    binding: {
      id: '44444444-4444-4444-8444-444444444444',
      chatId: scope.chatId,
      chatTitle: 'Соседи',
      state: 'verified',
      generation: scope.expectedBindingGeneration,
      revision: 1,
      verifiedAt: '2026-10-31T10:00:00.000Z',
    },
    permissions: ['manage_marketplace', 'arrange_listings'],
    counts: {
      listings: 0,
      readyListings: 0,
      approvedListings: 0,
      pendingApplications: 0,
      chats: 1,
    },
    canManage: true,
    sellerBotUrl: 'https://max.ru/synthetic_seller_bot',
  };
}

type HarnessActions = {
  tryImage(): Promise<string | null>;
  tryAppearance(): Promise<string | null>;
  resume(): Promise<void>;
  changeOriginalInputs(): void;
  readOriginalJournal: typeof readOriginalJournal;
};
async function readOriginalJournal() {
  return loadShopCommandJournal(originalScope);
}
declare global {
  interface Window {
    __shopCommandRuntimeHarness?: HarnessActions;
  }
}

function Owners() {
  const { scope } = useShop();
  const commands = useShopCommands();
  const seller = useSellerAccess();
  const [callbacks, setCallbacks] = useState<
    { owner: string; commandId: string; chatId: string }[]
  >([]);
  const imageCommand = useRef<Extract<ShopCommand, { operation: 'image' }>>({
    operation: 'image',
    input: {
      commandId: crypto.randomUUID(),
      fileName: 'original-cover.jpg',
      mimeType: 'image/jpeg',
      dataBase64: 'AQIDBAUGBwg=',
    },
  });
  const appearanceCommand = useRef<Extract<ShopCommand, { operation: 'appearance_apply' }>>({
    operation: 'appearance_apply',
    input: {
      commandId: crypto.randomUUID(),
      expectedRevision: 1,
      appearance: structuredClone(originalAppearance),
    },
  });
  const image = useShopMutation({ owner: 'runtime-image', page: 'appearance' }, (command) => {
    if ('input' in command && 'commandId' in command.input) {
      const commandId = command.input.commandId;
      setCallbacks((current) => [
        ...current,
        { owner: 'runtime-image', commandId, chatId: scope.chatId },
      ]);
    }
  });
  const appearance = useShopMutation(
    { owner: 'runtime-appearance', page: 'appearance' },
    (command) => {
      if ('input' in command && 'commandId' in command.input) {
        const commandId = command.input.commandId;
        setCallbacks((current) => [
          ...current,
          { owner: 'runtime-appearance', commandId, chatId: scope.chatId },
        ]);
      }
    },
  );
  useEffect(() => {
    const attempt = async (action: () => Promise<unknown>) => {
      try {
        await action();
        return null;
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
    };
    window.__shopCommandRuntimeHarness = {
      tryImage: () =>
        attempt(() =>
          image.mutateAsync(imageCommand.current, {
            imageTarget: 'coverImageUrl',
            appearanceDraft: structuredClone(originalAppearance),
          }),
        ),
      tryAppearance: () => attempt(() => appearance.mutateAsync(appearanceCommand.current)),
      resume: commands.resume,
      changeOriginalInputs() {
        imageCommand.current.input.fileName = 'changed-after-dispatch.jpg';
        imageCommand.current.input.dataBase64 = 'CQoLDA0ODxA=';
        appearanceCommand.current.input.expectedRevision = 99;
        appearanceCommand.current.input.appearance.name = 'Изменено после отправки';
        appearanceCommand.current.input.appearance.blocks.reverse();
      },
      readOriginalJournal,
    };
    return () => {
      delete window.__shopCommandRuntimeHarness;
    };
  });
  const ownerState = (mutation: ReturnType<typeof useShopMutation>) => ({
    blocked: mutation.blocked,
    editingBlocked: mutation.editingBlocked,
    pending: mutation.pendingCommand,
    receipt: mutation.receipt,
    data: mutation.data ?? null,
  });
  return (
    <>
      <ShopCommandRecovery />
      <SellerAccessAction />
      <button
        type="button"
        disabled={image.blocked}
        onClick={() =>
          image.mutate(imageCommand.current, {
            imageTarget: 'coverImageUrl',
            appearanceDraft: structuredClone(originalAppearance),
          })
        }
      >
        Загрузить изображение
      </button>
      <button
        type="button"
        disabled={appearance.blocked}
        onClick={() => appearance.mutate(appearanceCommand.current)}
      >
        Сохранить оформление
      </button>
      <output data-testid="runtime-state">
        {JSON.stringify({
          scope,
          key: commands.key,
          loading: commands.loading,
          busy: commands.busy,
          blocked: commands.blocked,
          readOnly: commands.readOnly,
          stale: commands.stale,
          storageError: commands.storageError,
          journal: commands.journal,
          image: ownerState(image),
          appearance: ownerState(appearance),
          invitation: ownerState(seller.mutation),
          callbacks,
        })}
      </output>
    </>
  );
}

function Fixture() {
  const [scope, setScope] = useState(originalScope);
  const [readOnly, setReadOnly] = useState(false);
  const module = useMemo(() => moduleFor(scope), [scope]);
  const value = useMemo(() => ({ api, scope, module }), [scope, module]);
  return (
    <>
      <button type="button" onClick={() => setScope(otherScope)}>
        Открыть другой магазин
      </button>
      <button type="button" onClick={() => setReadOnly((value) => !value)}>
        {readOnly ? 'Разрешить изменения' : 'Заблокировать изменения'}
      </button>
      <ShopContext.Provider value={value}>
        <ShopCommandProvider api={api} scope={scope} readOnly={readOnly}>
          <SellerAccessProvider>
            <Owners />
          </SellerAccessProvider>
        </ShopCommandProvider>
      </ShopContext.Provider>
    </>
  );
}

const client = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <Fixture />
  </QueryClientProvider>,
);
