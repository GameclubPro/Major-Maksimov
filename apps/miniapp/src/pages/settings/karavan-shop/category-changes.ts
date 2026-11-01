import type { MarketplaceManagementOperation } from '@maxim/contracts/karavan-marketplace-management';

export type ShopRules = Extract<
  MarketplaceManagementOperation,
  { operation: 'rules_preview' }
>['input']['rules'];

export function orderedShopCategories(rules: ShopRules): ShopRules['categoryOrder'] {
  const explicit = rules.categoryOrder.filter((id) => rules.allowedCategoryIds.includes(id));
  const remaining = rules.allowedCategoryIds
    .filter((id) => !explicit.includes(id))
    .sort((left, right) => left.localeCompare(right));
  return [...new Set([...explicit, ...remaining])];
}

export function sameShopRules(left: ShopRules, right: ShopRules): boolean {
  const normalize = (rules: ShopRules) => ({
    text: rules.text.trim(),
    categories: [...new Set(rules.allowedCategoryIds)].sort(),
    subcategories: [...new Set(rules.allowedSubcategoryIds)].sort(),
    order: orderedShopCategories(rules),
  });
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

export function shopRulesRequireAcceptance(original: ShopRules, next: ShopRules): boolean {
  return (
    original.text.trim() !== next.text.trim() ||
    original.allowedCategoryIds.some((id) => !next.allowedCategoryIds.includes(id)) ||
    original.allowedSubcategoryIds.some((id) => !next.allowedSubcategoryIds.includes(id))
  );
}

export function shopRulesNeedConfirmation(
  impact: { hiddenOffers: number; emptiedStores: number; affectedStores: number },
  delayed: boolean,
): boolean {
  return (
    delayed || impact.hiddenOffers > 0 || impact.emptiedStores > 0 || impact.affectedStores > 0
  );
}
