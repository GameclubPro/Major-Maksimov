import type {
  ApplySectionTargetPreviewResponse,
  ApplySettingsTarget,
} from '@maxim/contracts/settings';

export function formatApplyTargetSaveLabel(count: number): string {
  const singular = Math.abs(count) % 10 === 1 && Math.abs(count) % 100 !== 11;
  return `Сохранить в ${count} ${singular ? 'чате' : 'чатах'}`;
}

export function createDefaultApplySettingsTarget(): ApplySettingsTarget {
  return {
    mode: 'current',
    favoriteTypes: [],
    chatIds: [],
  };
}

export function isApplySettingsTargetPreviewCurrent(
  target: ApplySettingsTarget,
  preview: ApplySectionTargetPreviewResponse | null,
): boolean {
  if (!preview || preview.targetMode !== target.mode) {
    return false;
  }

  if (target.mode === 'favoriteTypes') {
    const favoriteTypes = new Set(target.favoriteTypes);
    const previewTypes = new Set(preview.favoriteTypes);
    return (
      favoriteTypes.size > 0 &&
      favoriteTypes.size === previewTypes.size &&
      [...favoriteTypes].every((favoriteType) => previewTypes.has(favoriteType))
    );
  }

  if (target.mode === 'selectedChats') {
    const chatIds = new Set(target.chatIds);
    const previewIds = new Set(preview.appliedChatIds);
    return (
      chatIds.size > 0 &&
      chatIds.size === previewIds.size &&
      [...chatIds].every((chatId) => previewIds.has(chatId))
    );
  }

  return true;
}

export function formatApplyTargetCountLabel(count: number): string {
  const normalized = Math.abs(count) % 100;
  const remainder = normalized % 10;
  if (normalized > 10 && normalized < 20) {
    return `${count} чатов`;
  }
  if (remainder === 1) {
    return `${count} чат`;
  }
  if (remainder > 1 && remainder < 5) {
    return `${count} чата`;
  }
  return `${count} чатов`;
}
