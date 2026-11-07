import {
  buildNavigationAllowlistPolicyKeys,
  type NavigationAllowlistKind,
  type NavigationAllowlistPolicyKey,
} from './settings-utils.js';
import { normalizeLinkRuleTarget } from './link-rules-policy-fields.js';

/** Resolve a pasted value; an explicit kind keeps the user's chosen scope. */
export function normalizeLinkRuleInput(
  value: string,
  kind?: NavigationAllowlistKind,
): NavigationAllowlistPolicyKey | null {
  const input = value.trim();
  if (kind) {
    const target = normalizeLinkRuleTarget(input, kind);
    return target ? { kind, target } : null;
  }

  const identityKinds: NavigationAllowlistKind[] =
    /^(?:user-id:|username:|max:\/\/user\/|\/?user\/)/iu.test(input)
      ? ['MAX_PROFILE']
      : /^chat-id:/iu.test(input)
        ? ['MAX_ENTITY']
        : /^(?:bot:|contact[-_]id:)/iu.test(input)
          ? ['MINI_APP']
          : /^url:/iu.test(input)
            ? ['MAX_ENTITY', 'MINI_APP']
            : [];
  for (const identityKind of identityKinds) {
    const target = normalizeLinkRuleTarget(input, identityKind);
    if (target) return { kind: identityKind, target };
  }
  if (identityKinds.length > 0) return null;

  const exactTarget = normalizeLinkRuleTarget(input, 'WEB_EXACT');
  if (!exactTarget) return null;
  const keys = buildNavigationAllowlistPolicyKeys(exactTarget, 'external_url');
  const identity = keys.find((key) => key.kind === 'MAX_ENTITY' || key.kind === 'MINI_APP');
  if (identity) return identity;

  const url = new URL(exactTarget);
  if (
    !/^https?:\/\//iu.test(input) &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash &&
    !url.port
  ) {
    const domain = normalizeLinkRuleTarget(exactTarget, 'WEB_DOMAIN');
    if (domain) return { kind: 'WEB_DOMAIN', target: domain };
  }
  return { kind: 'WEB_EXACT', target: exactTarget };
}
