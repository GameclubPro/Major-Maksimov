import type { ChatSummary, ManagedEntityFavoriteType, ManagedEntityType } from '@maxim/contracts';
import { AppIcon } from '../components/ui/app-icon';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { BackChevronIcon } from '../components/ui/entity-header-icons';
import { HOME_ENTITY_FAVORITE_ICONS, PlusCircleGlyph } from '../components/ui/compact-icons';
import { cn } from '../lib/cn';

export default function HomeCategoryEditorRow({
  entity,
  entityType,
  title,
  retryKey,
  categoryLabel,
  primaryFavoriteType,
  compositionCategory,
  disabled,
  pickerOpen,
  onPick,
  onAdd,
  onPrepare,
}: {
  entity: ChatSummary;
  entityType: ManagedEntityType;
  title: string;
  retryKey: string;
  categoryLabel: string;
  primaryFavoriteType: ManagedEntityFavoriteType | null;
  compositionCategory?: ManagedEntityFavoriteType;
  disabled: boolean;
  pickerOpen: boolean;
  onPick: (trigger: HTMLButtonElement, from?: ManagedEntityFavoriteType) => void;
  onAdd: (category: ManagedEntityFavoriteType) => void;
  onPrepare: () => void;
}) {
  const CategoryIcon = primaryFavoriteType
    ? HOME_ENTITY_FAVORITE_ICONS[primaryFavoriteType]
    : PlusCircleGlyph;
  const inCategory = primaryFavoriteType === compositionCategory;
  const opensPicker = !compositionCategory || primaryFavoriteType !== null;
  const compositionAction = inCategory ? 'Убрать' : primaryFavoriteType ? 'Перенести' : 'Добавить';
  return (
    <button
      type="button"
      className="chat-card__primary-link chat-card__category-editor"
      aria-label={
        compositionCategory
          ? `${compositionAction}: ${title}`
          : `Выбрать категорию: ${title}. Сейчас: ${categoryLabel}`
      }
      aria-pressed={compositionCategory ? inCategory : undefined}
      aria-haspopup={opensPicker ? 'dialog' : undefined}
      aria-controls={
        opensPicker
          ? compositionCategory
            ? 'home-sheet-membership'
            : 'home-sheet-favorite'
          : undefined
      }
      aria-expanded={opensPicker ? pickerOpen : undefined}
      disabled={disabled}
      onPointerEnter={() => void onPrepare()}
      onPointerDown={() => void onPrepare()}
      onClick={(event) => {
        if (compositionCategory && !primaryFavoriteType) onAdd(compositionCategory);
        else
          onPick(
            event.currentTarget,
            compositionCategory ? (primaryFavoriteType ?? undefined) : undefined,
          );
      }}
    >
      <EntityAvatar
        entityId={entity.id}
        retryKey={retryKey}
        title={title}
        entityType={entityType}
        avatarUrl={entity.avatarUrl ?? null}
        className="chat-card__avatar"
      />
      <span className="chat-card__title-wrap">
        <h3>{title}</h3>
        {!compositionCategory || (primaryFavoriteType && !inCategory) ? (
          <span className={cn('chat-card__category-value', primaryFavoriteType && 'is-active')}>
            <CategoryIcon aria-hidden focusable="false" />
            <span>{categoryLabel}</span>
          </span>
        ) : null}
      </span>
      {compositionCategory ? (
        <span className="chat-card__membership-mark" aria-hidden>
          <AppIcon icon={inCategory ? 'Check' : 'Plus'} />
        </span>
      ) : (
        <span className="chat-card__chevron" aria-hidden>
          <BackChevronIcon />
        </span>
      )}
    </button>
  );
}
