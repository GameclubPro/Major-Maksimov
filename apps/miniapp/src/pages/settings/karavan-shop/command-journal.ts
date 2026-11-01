import { z } from 'zod';
import {
  marketplaceManagementRequestSchema,
  marketplaceManagementResponseSchema,
  marketplaceAppearanceSchema,
  type MarketplaceManagementRequest,
  type MarketplaceManagementResponse,
  type MarketplaceAppearance,
} from '@maxim/contracts/karavan-marketplace-management';
import type { ShopScope, ShopCommand } from '../../../lib/api/karavan-shop-client';
import type { StorefrontPage } from '../storefront-workspace';

export type ShopJournalScope = ShopScope & { actorMaxUserId: string };
export type ShopCommandUi = {
  owner: string;
  page: StorefrontPage;
  imageTarget?: 'logoImageUrl' | 'coverImageUrl';
  appearanceDraft?: MarketplaceAppearance;
};
const scopeSchema = z
  .object({
    actorMaxUserId: z.string().min(1),
    chatId: z.string().regex(/^-?\d{1,24}$/u),
    marketplaceId: z.string().uuid(),
    expectedBindingGeneration: z.number().int().positive(),
  })
  .strict();
const uiSchema = z
  .object({
    owner: z.string().min(1).max(80),
    page: z.enum([
      'home',
      'catalog',
      'applications',
      'appearance',
      'categories',
      'chats',
      'publications',
      'settings',
    ]),
    imageTarget: z.enum(['logoImageUrl', 'coverImageUrl']).optional(),
    appearanceDraft: marketplaceAppearanceSchema.optional(),
  })
  .strict();
const pendingSchema = z
  .object({
    id: z.string().uuid(),
    hash: z.string().regex(/^[a-f0-9]{64}$/u),
    request: z.unknown(),
    ui: uiSchema,
    dispatchCount: z.number().int().nonnegative(),
    lease: z.object({ owner: z.string().uuid(), until: z.number() }).nullable(),
  })
  .strict();
const receiptSchema = z
  .object({ ui: uiSchema, request: z.unknown(), response: marketplaceManagementResponseSchema })
  .strict();
const journalSchema = z
  .object({
    version: z.literal(1),
    scope: scopeSchema,
    key: z.string(),
    revision: z.number().int().positive(),
    pending: pendingSchema.nullable(),
    results: z.record(z.string(), receiptSchema),
    appearanceDraft: marketplaceAppearanceSchema.nullable(),
  })
  .strict();
export type ShopCommandReceipt = {
  ui: ShopCommandUi;
  request: MarketplaceManagementRequest;
  response: MarketplaceManagementResponse;
};
export type ShopCommandJournal = Omit<z.infer<typeof journalSchema>, 'results'> & {
  results: Record<string, ShopCommandReceipt>;
};
type Media = { key: string; bytes: ArrayBuffer };
const gateSchema = z
  .object({ key: z.string(), journalKey: z.string(), pendingId: z.string().uuid() })
  .strict();
const timeoutMs = 8000;
export const shopJournalKey = (scope: ShopJournalScope) =>
  JSON.stringify([
    scope.actorMaxUserId,
    scope.chatId,
    scope.marketplaceId,
    scope.expectedBindingGeneration,
  ]);
const gateKeys = (scope: ShopJournalScope) => [
  JSON.stringify(['chat', scope.actorMaxUserId, scope.chatId]),
  JSON.stringify(['market', scope.actorMaxUserId, scope.marketplaceId]),
];
const storageFailure = () =>
  new Error('Не удалось проверить сохранённое действие. Повторите загрузку.');

export async function assertShopEntryWriteAvailable(
  actorMaxUserId: string,
  chatId: string,
  marketplaceId?: string | null,
): Promise<void> {
  const keys = [
    JSON.stringify(['chat', actorMaxUserId, chatId]),
    ...(marketplaceId ? [JSON.stringify(['market', actorMaxUserId, marketplaceId])] : []),
  ];
  await transaction<void>('readonly', (tx, done, fail) => {
    let remaining = keys.length;
    for (const key of keys) {
      const request = tx.objectStore('gates').get(key);
      request.onsuccess = () => {
        if (request.result !== undefined) {
          fail(new Error('Сначала продолжите сохранённое действие в магазине чата.'));
          return;
        }
        if (--remaining === 0) done();
      };
    }
  });
}

export function isShopWriteOperation(operation: ShopCommand['operation']): boolean {
  switch (operation) {
    case 'appearance_apply':
    case 'appearance_save':
    case 'appearance_publish':
    case 'pins_save':
    case 'invitation_create':
    case 'invitation_revoke':
    case 'image':
    case 'rules_cancel':
    case 'decide':
    case 'moderate_listing':
    case 'moderate_content':
    case 'reorder_listings':
    case 'rules_update':
    case 'settings':
    case 'status':
    case 'format_update':
      return true;
    case 'appearance':
    case 'administration_store':
    case 'pins':
    case 'catalog':
    case 'invitations':
    case 'detail':
    case 'listings':
    case 'applications':
    case 'content':
    case 'rules_preview':
    case 'format_preview':
      return false;
    default: {
      const exhaustive: never = operation;
      throw new Error(`Неизвестное действие: ${exhaustive}`);
    }
  }
}
function openJournal(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(storageFailure());
      return;
    }
    let finished = false;
    const timer = setTimeout(() => {
      finished = true;
      reject(storageFailure());
    }, timeoutMs);
    const request = indexedDB.open('major-shop-commands', 1);
    request.onupgradeneeded = () => {
      for (const name of ['journals', 'gates', 'media'])
        if (!request.result.objectStoreNames.contains(name))
          request.result.createObjectStore(name, { keyPath: 'key' });
    };
    request.onblocked = request.onerror = () => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        reject(storageFailure());
      }
    };
    request.onsuccess = () => {
      if (finished) request.result.close();
      else {
        finished = true;
        clearTimeout(timer);
        resolve(request.result);
      }
    };
  });
}
async function transaction<T>(
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction, done: (result: T) => void, fail: (cause: unknown) => void) => void,
): Promise<T> {
  const db = await openJournal();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['journals', 'gates', 'media'], mode);
    let result: T,
      provided = false,
      failure: unknown;
    const timer = setTimeout(() => {
      failure = storageFailure();
      try {
        tx.abort();
      } catch {
        db.close();
        reject(failure);
      }
    }, timeoutMs);
    const close = () => {
      clearTimeout(timer);
      db.close();
    };
    tx.oncomplete = () => {
      close();
      if (provided) resolve(result);
      else reject(storageFailure());
    };
    tx.onerror = tx.onabort = () => {
      close();
      reject(failure ?? storageFailure());
    };
    const fail = (cause: unknown) => {
      failure = cause;
      tx.abort();
    };
    try {
      work(
        tx,
        (value) => {
          result = value;
          provided = true;
        },
        fail,
      );
    } catch (cause) {
      fail(cause);
    }
  });
}
function checked(value: unknown): ShopCommandJournal {
  const parsed = journalSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.key !== shopJournalKey(parsed.data.scope) ||
    Object.keys(parsed.data.results).length > 40
  )
    throw new Error(
      'Сохранённое действие повреждено. Повторите загрузку или обратитесь в поддержку.',
    );
  return parsed.data as ShopCommandJournal;
}
function scopeMatches(scope: ShopJournalScope, request: MarketplaceManagementRequest) {
  return (
    scope.chatId === request.chatId &&
    scope.marketplaceId === request.marketplaceId &&
    scope.expectedBindingGeneration === request.expectedBindingGeneration
  );
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export async function shopCommandHash(request: MarketplaceManagementRequest): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable(request)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function loadShopCommandJournal(
  scope: ShopJournalScope,
): Promise<ShopCommandJournal | null> {
  scopeSchema.parse(scope);
  const result = await transaction<ShopCommandJournal | null>('readonly', (tx, done, fail) => {
    const gates: z.infer<typeof gateSchema>[] = [];
    let loaded = 0;
    const finish = () => {
      if (++loaded !== 2) return;
      if (
        gates.some(
          (gate) =>
            gate.journalKey !== gates[0]?.journalKey || gate.pendingId !== gates[0]?.pendingId,
        )
      ) {
        fail(storageFailure());
        return;
      }
      const request = tx.objectStore('journals').get(gates[0]?.journalKey ?? shopJournalKey(scope));
      request.onsuccess = () => {
        try {
          if (request.result === undefined && !gates.length) {
            done(null);
            return;
          }
          const value = checked(request.result);
          if (
            value.scope.actorMaxUserId !== scope.actorMaxUserId ||
            (gates.length &&
              (value.pending?.id !== gates[0]!.pendingId ||
                !gateKeys(value.scope).some((key) => gateKeys(scope).includes(key))))
          )
            throw storageFailure();
          done(value);
        } catch (cause) {
          fail(cause);
        }
      };
    };
    for (const key of gateKeys(scope)) {
      const request = tx.objectStore('gates').get(key);
      request.onsuccess = () => {
        try {
          if (request.result !== undefined) gates.push(gateSchema.parse(request.result));
          finish();
        } catch (cause) {
          fail(cause);
        }
      };
    }
  });
  if (result?.pending) await restoreShopCommand(result);
  return result;
}
export async function reserveShopCommand(
  scope: ShopJournalScope,
  input: MarketplaceManagementRequest,
  ui: ShopCommandUi,
): Promise<ShopCommandJournal> {
  const request = marketplaceManagementRequestSchema.parse(input);
  uiSchema.parse(ui);
  scopeSchema.parse(scope);
  if (!scopeMatches(scope, request) || !isShopWriteOperation(request.command.operation))
    throw new Error('Изменился магазин действия. Обновите экран.');
  const hash = await shopCommandHash(request),
    id = crypto.randomUUID();
  const packed = structuredClone(request);
  let bytes: ArrayBuffer | null = null;
  if (packed.command.operation === 'image') {
    const raw = atob(packed.command.input.dataBase64);
    bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0)).buffer;
    Reflect.deleteProperty(packed.command.input, 'dataBase64');
  }
  const key = shopJournalKey(scope);
  await transaction<void>('readwrite', (tx, done, fail) => {
    let previous: ShopCommandJournal | null = null,
      count = 0;
    const gates = gateKeys(scope);
    const finish = () => {
      if (++count !== 3) return;
      try {
        if (previous?.pending) throw new Error('Сначала продолжите сохранённое действие.');
        const pending = { id, hash, request: packed, ui, dispatchCount: 0, lease: null };
        const next: ShopCommandJournal = {
          version: 1,
          key,
          scope,
          revision: (previous?.revision ?? 0) + 1,
          pending,
          results: previous?.results ?? {},
          appearanceDraft: ui.appearanceDraft ?? previous?.appearanceDraft ?? null,
        };
        tx.objectStore('journals').put(next);
        for (const gate of gates)
          tx.objectStore('gates').put({ key: gate, journalKey: key, pendingId: id });
        if (bytes) tx.objectStore('media').put({ key: id, bytes } satisfies Media);
        done();
      } catch (cause) {
        fail(cause);
      }
    };
    const prior = tx.objectStore('journals').get(key);
    prior.onsuccess = () => {
      try {
        previous = prior.result === undefined ? null : checked(prior.result);
        finish();
      } catch (cause) {
        fail(cause);
      }
    };
    for (const gate of gates) {
      const get = tx.objectStore('gates').get(gate);
      get.onsuccess = () => {
        if (get.result !== undefined) {
          fail(new Error('В другом окне есть незавершённое действие. Сначала продолжите его.'));
          return;
        }
        finish();
      };
    }
  });
  const result = await loadShopCommandJournal(scope);
  if (!result?.pending || result.pending.id !== id || result.pending.hash !== hash)
    throw storageFailure();
  return result;
}
export async function restoreShopCommand(
  journal: ShopCommandJournal,
): Promise<MarketplaceManagementRequest> {
  if (!journal.pending) throw storageFailure();
  const packed = structuredClone(journal.pending.request);
  if (
    packed &&
    typeof packed === 'object' &&
    'command' in packed &&
    packed.command &&
    typeof packed.command === 'object' &&
    'operation' in packed.command &&
    packed.command.operation === 'image'
  ) {
    const media = await transaction<Media | undefined>('readonly', (tx, done) => {
      const get = tx.objectStore('media').get(journal.pending!.id);
      get.onsuccess = () => done(get.result);
    });
    if (
      !media ||
      !(media.bytes instanceof ArrayBuffer) ||
      !media.bytes.byteLength ||
      !('input' in packed.command) ||
      !packed.command.input ||
      typeof packed.command.input !== 'object'
    )
      throw new Error(
        'Фото сохранённого действия недоступно. Повторите загрузку или обратитесь в поддержку.',
      );
    const array = new Uint8Array(media.bytes),
      parts: string[] = [];
    for (let i = 0; i < array.length; i += 16384)
      parts.push(String.fromCharCode(...array.subarray(i, i + 16384)));
    Object.assign(packed.command.input, { dataBase64: btoa(parts.join('')) });
  }
  const request = marketplaceManagementRequestSchema.parse(packed);
  if (
    !scopeMatches(journal.scope, request) ||
    (await shopCommandHash(request)) !== journal.pending.hash
  )
    throw new Error('Сохранённое действие изменилось. Обратитесь в поддержку.');
  return request;
}
async function updatePending(
  journal: ShopCommandJournal,
  change: (current: ShopCommandJournal) => ShopCommandJournal,
): Promise<ShopCommandJournal> {
  return transaction('readwrite', (tx, done, fail) => {
    const request = tx.objectStore('journals').get(journal.key);
    request.onsuccess = () => {
      try {
        const current = checked(request.result);
        if (
          !current.pending ||
          current.pending.id !== journal.pending?.id ||
          current.pending.hash !== journal.pending.hash ||
          current.revision !== journal.revision ||
          current.pending.lease?.owner !== journal.pending.lease?.owner
        )
          throw new Error('Действие изменилось в другом окне. Повторите загрузку.');
        const next = change(current);
        tx.objectStore('journals').put(next);
        if (!next.pending) {
          for (const key of gateKeys(current.scope)) tx.objectStore('gates').delete(key);
          tx.objectStore('media').delete(current.pending.id);
        }
        done(next);
      } catch (cause) {
        fail(cause);
      }
    };
  });
}
export async function claimShopCommand(journal: ShopCommandJournal): Promise<ShopCommandJournal> {
  return updatePending(journal, (current) => {
    if (current.pending!.lease && current.pending!.lease.until > Date.now())
      throw new Error('Действие выполняется в другом окне. Повторите позже.');
    return {
      ...current,
      revision: current.revision + 1,
      pending: {
        ...current.pending!,
        dispatchCount: current.pending!.dispatchCount + 1,
        lease: { owner: crypto.randomUUID(), until: Date.now() + 60000 },
      },
    };
  });
}
export async function releaseShopCommand(journal: ShopCommandJournal): Promise<ShopCommandJournal> {
  return updatePending(journal, (current) => ({
    ...current,
    revision: current.revision + 1,
    pending: { ...current.pending!, lease: null },
  }));
}
export async function settleShopCommand(
  journal: ShopCommandJournal,
  input: MarketplaceManagementResponse | null,
): Promise<ShopCommandJournal> {
  const request = await restoreShopCommand(journal);
  const response = input === null ? null : marketplaceManagementResponseSchema.parse(input);
  if (response && response.operation !== request.command.operation)
    throw new Error('Ответ магазина изменился. Продолжите сохранённое действие.');
  return updatePending(journal, (current) => {
    const pending = current.pending!;
    const results = { ...current.results };
    if (
      response?.operation === 'invitation_revoke' &&
      response.data.revoked &&
      request.command.operation === 'invitation_revoke'
    ) {
      const invitationId = request.command.input.invitationId;
      for (const [owner, receipt] of Object.entries(results))
        if (
          receipt.response.operation === 'invitation_create' &&
          receipt.response.data.id === invitationId
        )
          delete results[owner];
    }
    let appearanceDraft = current.appearanceDraft;
    if (response?.operation === 'image' && pending.ui.imageTarget && pending.ui.appearanceDraft)
      appearanceDraft = {
        ...pending.ui.appearanceDraft,
        [pending.ui.imageTarget]: response.data.url,
      };
    if (response?.operation === 'appearance_apply' || response?.operation === 'appearance_save')
      appearanceDraft = null;
    return {
      ...current,
      revision: current.revision + 1,
      pending: null,
      appearanceDraft,
      results: response
        ? {
            ...results,
            [pending.ui.owner]: {
              ui: pending.ui,
              request: pending.request as MarketplaceManagementRequest,
              response,
            },
          }
        : results,
    };
  });
}
