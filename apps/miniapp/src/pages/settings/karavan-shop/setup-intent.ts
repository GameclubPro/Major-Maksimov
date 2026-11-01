import { z } from 'zod';

export type ShopSetupIntent =
  | { kind: 'create' }
  | { kind: 'connect_existing' }
  | { kind: 'replace'; previousMarketplaceId: string }
  | { kind: 'add_chats'; marketplaceId: string };

export const shopSetupDraftSchema = z
  .object({
    mode: z.enum(['new', 'existing']),
    existingId: z.string().uuid().nullable(),
    format: z.enum(['storefront', 'community']).nullable().optional(),
    administrationStoreId: z.string().uuid().nullable().optional(),
    name: z.string().max(120),
    rules: z.string().max(12000),
    categories: z.array(z.string().max(100)).max(40),
    subcategories: z.array(z.string().max(100)).max(1000),
    initialized: z.boolean(),
    admissionPolicy: z.enum(['applications', 'invitation']),
    chatIds: z
      .array(z.string().regex(/^-?\d{1,24}$/u))
      .min(1)
      .max(20),
  })
  .strict();

export type ShopSetupDraft = z.infer<typeof shopSetupDraftSchema>;

export function shopSetupIntentKey(intent: ShopSetupIntent): string {
  if (intent.kind === 'add_chats') return `add_chats:${intent.marketplaceId}`;
  if (intent.kind === 'replace') return `replace:${intent.previousMarketplaceId}`;
  return intent.kind;
}

export function shopSetupDraftKey(
  actorId: string,
  chatId: string,
  intent: ShopSetupIntent,
): string {
  return `karavan-setup-draft:v2:${actorId}:${chatId}:${shopSetupIntentKey(intent)}`;
}

export function legacyShopSetupDraftKey(
  actorId: string,
  chatId: string,
  intent: ShopSetupIntent,
): string {
  return `karavan-setup-draft:v1:${actorId}:${chatId}${intent.kind === 'add_chats' ? `:${intent.marketplaceId}` : ''}`;
}

export function restoreShopSetupDraft(
  raw: string | null,
  chatId: string,
  intent: ShopSetupIntent,
): ShopSetupDraft | null {
  if (!raw) return null;
  try {
    const parsed = shopSetupDraftSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const draft = parsed.data;
    if (draft.chatIds[0] !== chatId || new Set(draft.chatIds).size !== draft.chatIds.length)
      return null;
    // FLAG: A restored editable draft cannot change the chosen operation or its scope.
    // Incompatible legacy drafts remain stored; never silently drop their selected chats.
    if (intent.kind === 'create')
      return draft.mode === 'new' && draft.existingId === null && draft.chatIds.length === 1
        ? draft
        : null;
    if (draft.mode !== 'existing') return null;
    if (intent.kind === 'add_chats')
      return draft.existingId === intent.marketplaceId ? draft : null;
    if (draft.chatIds.length !== 1) return null;
    if (intent.kind === 'replace' && draft.existingId === intent.previousMarketplaceId) return null;
    return draft;
  } catch {
    return null;
  }
}

export function shopSetupChangeRequiresAcceptance(patch: Partial<ShopSetupDraft>): boolean {
  return Object.keys(patch).some((key) => key !== 'name' && key !== 'initialized');
}
