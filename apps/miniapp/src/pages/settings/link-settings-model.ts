import {
  normalizeLinkRuleInput,
  type LinkRule,
  type NavigationAllowlistKind,
} from '@maxim/contracts/settings';

export const LINK_RULE_KIND_LABELS: Record<NavigationAllowlistKind, string> = {
  WEB_EXACT: 'Только эта ссылка',
  WEB_DOMAIN: 'Весь сайт и поддомены',
  MAX_PROFILE: 'Профиль MAX',
  MAX_ENTITY: 'Чат или канал MAX',
  MINI_APP: 'Мини-приложение MAX',
};

export function inferLinkRuleKind(value: string): NavigationAllowlistKind {
  const first = value.trim().split(/\s/u)[0] ?? '';
  // FLAG: A pasted full URL keeps exact scope, including an otherwise empty root path.
  if (/^https?:\/\//iu.test(first)) {
    const inferred = normalizeLinkRuleInput(first);
    return inferred && !['WEB_DOMAIN', 'WEB_EXACT'].includes(inferred.kind)
      ? inferred.kind
      : 'WEB_EXACT';
  }
  return normalizeLinkRuleInput(first)?.kind ?? 'WEB_EXACT';
}

export function displayLinkRuleTarget(rule: Pick<LinkRule, 'kind' | 'target'>): string {
  const { kind, target } = rule;
  if (kind === 'MAX_PROFILE') {
    if (target.startsWith('user-id:')) return `max://user/${target.slice(8)}`;
    if (target.startsWith('username:')) return `@${target.slice(9)}`;
  }
  if (target.startsWith('url:')) return target.slice(4);
  if (kind === 'MINI_APP' && target.startsWith('bot:')) return `@${target.slice(4)}`;
  return target;
}

export function linkRuleContains(parent: LinkRule, child: LinkRule): boolean {
  if (parent.kind !== 'WEB_DOMAIN') return false;
  let hostname = child.target;
  if (child.kind !== 'WEB_DOMAIN') {
    if (child.kind !== 'WEB_EXACT') return false;
    try {
      hostname = new URL(child.target).hostname;
    } catch {
      return false;
    }
  }
  return (
    (hostname === parent.target || hostname.endsWith(`.${parent.target}`)) &&
    !(child.kind === 'WEB_DOMAIN' && child.target === parent.target)
  );
}

export function ruleExpiryLabel(expiresAt: string | null, now = Date.now()): string {
  if (!expiresAt) return 'Без срока';
  if (Date.parse(expiresAt) <= now) return 'Срок истёк';
  return `До ${new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(expiresAt))}`;
}

export function localExpiryParts(expiresAt: string | null): { day: string; time: string } {
  if (!expiresAt) return { day: '', time: '23:59' };
  const date = new Date(expiresAt);
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}
