import type { ShopSetupDraft } from './setup-intent';

const drafts = new Map<string, { draft: ShopSetupDraft; persist: boolean }>();

// FLAG: Editable session drafts are separate from accepted server operations.
// Preserve scope and unreadable device copies across local Back navigation.
export function rememberShopDraft(key: string, draft: ShopSetupDraft, persist: boolean): void {
  drafts.delete(key);
  if (drafts.size >= 64) drafts.delete(drafts.keys().next().value!);
  drafts.set(key, { draft: structuredClone(draft), persist });
}

export function recallShopDraft(key: string) {
  const saved = drafts.get(key);
  return saved ? { ...saved, draft: structuredClone(saved.draft) } : null;
}
