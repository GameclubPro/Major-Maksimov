import {
  chatSanctionsPageSchema,
  chatSanctionsQuerySchema,
  type ChatSanctionItem,
} from '@maxim/contracts/chat-sanctions';
import type { LogsDashboardViolation } from '@maxim/contracts';
import {
  addDays,
  buildPreviewAvatarDataUrl,
  buildPreviewProfileUrl,
  buildPreviewProfileHandoffUrl,
} from './preview-transport-shared';

export function createPreviewOlderSanctions(now: Date): LogsDashboardViolation[] {
  return [
    {
      id: 'sanction-old-ban',
      action: 'BAN',
      ruleCode: 'MANUAL_BAN',
      userId: 'preview-old-ban',
      userDisplayName: 'Александр Кузнецов',
      avatarUrl: buildPreviewAvatarDataUrl('Александр Кузнецов', '#4d94ff', '#2b64dd'),
      profileUrl: buildPreviewProfileUrl('alexander-preview'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('alexander-preview'),
      createdAt: addDays(now, -420).toISOString(),
      maskedExcerpt: null,
      metadata: null,
    },
    {
      id: 'sanction-old-mute',
      action: 'MUTE',
      ruleCode: 'MANUAL_MUTE',
      userId: 'preview-old-mute',
      userDisplayName: 'Екатерина Михайлова',
      avatarUrl: buildPreviewAvatarDataUrl('Екатерина Михайлова', '#3cc58b', '#0f9f70'),
      profileUrl: buildPreviewProfileUrl('ekaterina-preview'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('ekaterina-preview'),
      createdAt: addDays(now, -95).toISOString(),
      maskedExcerpt: null,
      metadata: { mutePermanent: true },
    },
  ];
}

export function buildPreviewSanctionsPage(
  violations: LogsDashboardViolation[],
  url: URL,
  now: Date,
) {
  const query = chatSanctionsQuerySchema.parse(Object.fromEntries(url.searchParams));
  const history = violations
    .filter(
      (item) =>
        item.action === 'MUTE' ||
        item.action === 'BAN' ||
        ['MANUAL_UNMUTE', 'MANUAL_UNBAN'].includes(item.ruleCode),
    )
    .sort(
      (left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id),
    );
  const items: ChatSanctionItem[] = [];
  for (const [index, item] of history.entries()) {
    if (item.action !== 'MUTE' && item.action !== 'BAN') continue;
    const next = history.slice(index + 1).find((later) => later.userId === item.userId);
    const metadata =
      item.metadata && typeof item.metadata === 'object'
        ? (item.metadata as Record<string, unknown>)
        : {};
    const permanent = item.action === 'BAN' || metadata.mutePermanent === true;
    const expiresAt =
      !permanent && typeof metadata.muteExpiresAt === 'string' ? metadata.muteExpiresAt : null;
    const expired =
      expiresAt &&
      Date.parse(expiresAt) <= now.getTime() &&
      (!next || Date.parse(expiresAt) <= Date.parse(next.createdAt));
    const status: ChatSanctionItem['status'] = expired
      ? 'expired'
      : next
        ? next.ruleCode.startsWith('MANUAL_UN')
          ? 'released'
          : 'replaced'
        : permanent || expiresAt
          ? 'active'
          : 'review';
    const endedAt = expired ? expiresAt : (next?.createdAt ?? null);
    if (endedAt && Date.parse(endedAt) < now.getTime() - 365 * 86_400_000) continue;
    if (query.status === 'archive' && !['expired', 'released', 'replaced'].includes(status))
      continue;
    if (query.status === 'active' && status !== 'active') continue;
    if (query.status === 'review' && status !== 'review') continue;
    if (query.action !== 'all' && item.action !== query.action) continue;
    if (query.userId && item.userId !== query.userId) continue;
    if (
      query.search &&
      item.userId !== query.search &&
      !(item.userDisplayName ?? '')
        .toLocaleLowerCase('ru-RU')
        .includes(query.search.toLocaleLowerCase('ru-RU'))
    )
      continue;
    items.push({
      id: item.id,
      userId: item.userId,
      userDisplayName: item.userDisplayName ?? 'Участник',
      avatarUrl: item.avatarUrl ?? null,
      profileHandoffUrl: item.profileHandoffUrl ?? null,
      action: item.action,
      ruleCode: item.ruleCode,
      reason: null,
      operator: item.ruleCode.startsWith('MANUAL_') ? 'ADMIN' : 'BOT',
      actorDisplayName: null,
      createdAt: item.createdAt,
      expiresAt,
      endedAt,
      permanent,
      status,
      releaseAction: status === 'active' ? (item.action === 'MUTE' ? 'UNMUTE' : 'UNBAN') : null,
      banOnRejoin: metadata.mode === 'LOCAL_REJOIN',
    });
  }
  items.reverse();
  const start = Math.max(0, Number(query.cursor ?? 0) || 0);
  const end = start + query.limit;
  return chatSanctionsPageSchema.parse({
    items: items.slice(start, end),
    serverTime: now.toISOString(),
    hasMore: end < items.length,
    nextCursor: end < items.length ? String(end) : null,
  });
}
