import { AppIcon as IconoirSprite } from './ui/app-icon';
import {
  MANAGED_GIVEAWAY_MAX_PRIZES,
  MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS,
  MANAGED_GIVEAWAY_PRIZE_TITLE_MAX_LENGTH,
  MANAGED_GIVEAWAY_TITLE_MAX_LENGTH,
  type ManagedGiveawayDetails,
  type ManagedGiveawaySummary,
  type ManagedGiveawayWinner,
} from '@maxim/contracts/giveaway';
import type { ChatSummary } from '@maxim/contracts/managed-entities';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  forwardRef,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ForwardedRef,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';

import { ApiRequestError } from '../lib/api-request-error';
import { getChannels } from '../lib/api/root-client';
import {
  cancelManagedGiveaway,
  closeManagedGiveaway,
  createManagedGiveaway,
  deleteManagedGiveaway,
  getManagedGiveaway,
  getManagedGiveaways,
  markManagedGiveawayWinnerDelivered,
  publishManagedGiveaway,
  refreshManagedGiveawayPublication,
  rerollManagedGiveawayWinner,
  resolveManagedGiveawayRequiredChannel,
  updateManagedGiveaway,
} from '../lib/api/managed-giveaway-client';
import type { ApiTransport } from '../lib/api/transport';
import type { UpdateManagedGiveawayPayload } from '../lib/api/shared-types';
import { describeUserFacingError } from '../lib/user-facing-error';
import { cn } from '../lib/cn';
import { giveawayImageSource } from '../lib/giveaway-image';
import { useHintPopoverAutoPosition } from '../lib/hint-popover';
import {
  canShareNativeContent,
  maxNotify,
  maxSelectionChanged,
  openMaxBotLink,
  shareNativeContent,
} from '../lib/max-bridge';
import { useNativeBackHandler } from '../lib/native-back';
import { queryKeys } from '../lib/query-keys';
import { TimeField } from './ui/time-field';
import { DateField } from './ui/date-field';
import { useToast } from './ui/toast';

const MIN_CLAIM_HOURS = 1;
const MAX_CLAIM_HOURS = 336;
const FINISH_PRESETS = [
  { hours: 24, label: '24 часа' },
  { hours: 48, label: '48 часов' },
  { hours: 168, label: '7 дней' },
] as const;

const LazyActionConfirmSheet = lazy(async () => {
  const module = await import('./ui/action-confirm-sheet');
  return { default: module.ActionConfirmSheet };
});

type GiveawayEditorMode = 'closed' | 'create' | 'edit';
export type ManagedGiveawayCardHandle = {
  requestClose: () => boolean;
};

type ManagedGiveawayCardProps = {
  api: ApiTransport;
  entityType: 'chat' | 'channel';
  entityId: string;
  onClosePanel: () => void;
};
type GiveawayEditorStepId = 'basics' | 'conditions' | 'prizes';
type GiveawayPrizeMode = 'same' | 'different';
type GiveawayHintKey =
  | 'dashboard'
  | 'title'
  | 'timing'
  | 'start'
  | 'finish'
  | 'claim'
  | 'conditions'
  | 'conditionsOwned'
  | 'conditionsLink'
  | 'prizes';
type GiveawayValidationResult = { valid: boolean; message: string };
type GiveawayValidationFocusTarget = 'title' | 'endsAt' | 'channels' | 'prizes';
type GiveawayConfirmationAction =
  | { kind: 'publish' }
  | { kind: 'discard-editor'; origin: 'back' | 'reset'; closePanel?: boolean }
  | { kind: 'cancel-draft'; giveawayId: string }
  | { kind: 'close'; giveawayId: string; title: string }
  | { kind: 'reroll'; giveawayId: string; winnerId: string; winnerName: string }
  | { kind: 'deliver'; giveawayId: string; winnerId: string; winnerName: string }
  | { kind: 'delete'; giveawayId: string; title: string };

type GiveawayEditorDraft = {
  title: string;
  description: string;
  startsAtLocal: string;
  endsAtLocal: string;
  claimHours: number;
  requiredChannelIds: string[];
  prizeMode: GiveawayPrizeMode;
  samePrizeTitle: string;
  prizes: string[];
  imageEnabled: boolean;
  imageBase64: string;
  imageMimeType: string;
  imageFileName: string;
};

const GIVEAWAY_EDITOR_STEPS = [
  {
    id: 'basics',
    label: 'Основа',
    title: 'Название и сроки',
  },
  {
    id: 'conditions',
    label: 'Условия',
    title: 'Кто участвует',
  },
  {
    id: 'prizes',
    label: 'Призы',
    title: 'Сколько мест и что получат',
  },
] as const satisfies ReadonlyArray<{
  id: GiveawayEditorStepId;
  label: string;
  title: string;
}>;

function GiveawayHintAnchor({
  hintKey,
  openHintKey,
  onToggleHint,
  label,
  children,
}: {
  hintKey: GiveawayHintKey;
  openHintKey: GiveawayHintKey | null;
  onToggleHint: (key: GiveawayHintKey) => void;
  label: string;
  children: string;
}) {
  const isOpen = openHintKey === hintKey;

  return (
    <span className="channel-settings-hint-anchor managed-giveaway__hint-anchor">
      <button
        type="button"
        className={cn('settings-info-button', 'managed-giveaway__info-button', isOpen && 'is-open')}
        aria-label={label}
        aria-controls={`giveaway-hint-${hintKey}`}
        aria-expanded={isOpen}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onToggleHint(hintKey);
        }}
      >
        <span aria-hidden>i</span>
      </button>
      {isOpen ? (
        <p
          id={`giveaway-hint-${hintKey}`}
          className="channel-settings-hint-popover managed-giveaway__hint-popover"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {children}
        </p>
      ) : null}
    </span>
  );
}

function formatApiError(error: unknown, fallback: string): string {
  return describeUserFacingError(error, fallback);
}

function buildStatusLabel(status: ManagedGiveawaySummary['status']): string {
  if (status === 'DRAFT') {
    return 'Черновик';
  }
  if (status === 'SCHEDULED') {
    return 'Запланирован';
  }
  if (status === 'ACTIVE') {
    return 'Идёт';
  }
  if (status === 'DRAWING') {
    return 'Подводим итоги';
  }
  if (status === 'COMPLETED') {
    return 'Завершён';
  }
  return 'Отменён';
}

function buildStatusTone(
  status: ManagedGiveawaySummary['status'],
): 'is-success' | 'is-warning' | 'is-danger' | 'is-muted' {
  if (status === 'ACTIVE' || status === 'COMPLETED') {
    return 'is-success';
  }
  if (status === 'SCHEDULED' || status === 'DRAWING' || status === 'DRAFT') {
    return 'is-warning';
  }
  if (status === 'CANCELED') {
    return 'is-danger';
  }
  return 'is-muted';
}

function formatDateTime(value: string | null, fallback = 'не задано'): string {
  if (!value) {
    return fallback;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDateTimeInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function formatDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatTimeInputValue(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function parseDateTimeInput(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function roundToNextQuarter(date: Date): Date {
  const rounded = new Date(date.getTime() + 15 * 60 * 1000);
  rounded.setSeconds(0, 0);
  const remainder = rounded.getMinutes() % 15;
  if (remainder !== 0) {
    rounded.setMinutes(rounded.getMinutes() + (15 - remainder));
  }
  return rounded;
}

function readDateInputPart(value: string): string {
  const parsed = parseDateTimeInput(value);
  return parsed ? formatDateInputValue(parsed) : '';
}

function readTimeInputPart(value: string, fallback = '12:00'): string {
  const parsed = parseDateTimeInput(value);
  return parsed ? formatTimeInputValue(parsed) : fallback;
}

function mergeDateAndTime(dateValue: string, timeValue: string, fallbackDate: Date): string {
  if (!dateValue) {
    return '';
  }

  const safeTime = /^\d{2}:\d{2}$/u.test(timeValue)
    ? timeValue
    : formatTimeInputValue(fallbackDate);
  const [hours, minutes] = safeTime.split(':').map((item) => Number.parseInt(item, 10) || 0);
  const merged = new Date(`${dateValue}T00:00`);
  merged.setHours(hours, minutes, 0, 0);
  return formatDateTimeInputValue(merged);
}

function toDateTimeInputFromIso(value: string | null): string {
  if (!value) {
    return '';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  return formatDateTimeInputValue(parsed);
}

function addHours(base: Date, hours: number): Date {
  return new Date(base.getTime() + hours * 60 * 60 * 1000);
}

function createDefaultEditorDraft(): GiveawayEditorDraft {
  const now = new Date();
  const roundedNow = new Date(now.getTime());
  roundedNow.setSeconds(0, 0);
  const defaultEnd = addHours(roundedNow, 24);

  return {
    title: 'Новый розыгрыш',
    description: '',
    startsAtLocal: '',
    endsAtLocal: formatDateTimeInputValue(defaultEnd),
    claimHours: 24,
    requiredChannelIds: [],
    prizeMode: 'same',
    samePrizeTitle: '',
    prizes: [''],
    imageEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
  };
}

function normalizePrizeTitle(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

function resolveRepeatedPrizeTitle(prizes: string[]): string | null {
  if (prizes.length === 0) {
    return null;
  }

  const normalizedTitles = prizes.map((item) => normalizePrizeTitle(item));
  const firstTitle = normalizedTitles[0] ?? '';
  if (firstTitle && normalizedTitles.every((item) => item === firstTitle)) {
    return firstTitle;
  }

  return null;
}

function buildPrizeRowsFromSameTitle(title: string, count: number): string[] {
  return Array.from({ length: count }, () => title);
}

function buildDashboardPrizeGroups(
  prizes: ManagedGiveawayDetails['prizes'],
): Array<{ id: string; label: string; title: string; count: number }> {
  const sortedPrizes = [...prizes].sort((left, right) => left.position - right.position);
  const repeatedTitle = resolveRepeatedPrizeTitle(
    sortedPrizes.map((prize) => prize.displayTitle || prize.title),
  );
  if (repeatedTitle) {
    return [
      {
        id: 'same-prize',
        label: `${sortedPrizes.length} мест`,
        title: repeatedTitle,
        count: sortedPrizes.length,
      },
    ];
  }

  return sortedPrizes.map((prize) => ({
    id: prize.id,
    label: `${prize.position} место`,
    title: prize.displayTitle || prize.title,
    count: 1,
  }));
}

function toEditorDraft(giveaway: ManagedGiveawayDetails): GiveawayEditorDraft {
  const displayPrizeTitles = giveaway.prizes
    .slice()
    .sort((left, right) => left.position - right.position)
    .map((prize) => prize.displayTitle || prize.title);
  const repeatedPrizeTitle = resolveRepeatedPrizeTitle(displayPrizeTitles);

  return {
    title: giveaway.title,
    description: giveaway.description,
    startsAtLocal: toDateTimeInputFromIso(giveaway.startsAt),
    endsAtLocal: toDateTimeInputFromIso(giveaway.endsAt),
    claimHours: giveaway.claimHours,
    requiredChannelIds: giveaway.requiredChannelIds.filter(
      (item) => item !== giveaway.sourceChatId,
    ),
    prizeMode: repeatedPrizeTitle ? 'same' : 'different',
    samePrizeTitle: repeatedPrizeTitle ?? '',
    prizes: repeatedPrizeTitle
      ? buildPrizeRowsFromSameTitle(repeatedPrizeTitle, displayPrizeTitles.length)
      : displayPrizeTitles,
    imageEnabled: giveaway.imageEnabled,
    imageBase64: giveaway.imageBase64,
    imageMimeType: giveaway.imageMimeType,
    imageFileName: giveaway.imageFileName,
  };
}

function normalizeChannelId(value: string): string {
  return value.trim().replace(/\s+/gu, '');
}

function normalizeChannelLink(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const withProtocol = /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    const host = parsed.hostname.toLowerCase().replace(/^www\./u, '');
    const path = parsed.pathname.replace(/\/+$/u, '');
    return `${host}${path}`.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

function validateBasicsDraft(draft: GiveawayEditorDraft): GiveawayValidationResult {
  if (!draft.title.trim()) {
    return { valid: false, message: 'Введите название.' };
  }

  if (!draft.endsAtLocal.trim()) {
    return { valid: false, message: 'Укажите дату и время завершения.' };
  }

  const startsAt = draft.startsAtLocal.trim() ? parseDateTimeInput(draft.startsAtLocal) : null;
  if (draft.startsAtLocal.trim() && !startsAt) {
    return { valid: false, message: 'Проверьте дату начала.' };
  }

  const endsAt = parseDateTimeInput(draft.endsAtLocal);
  if (!endsAt) {
    return { valid: false, message: 'Проверьте дату завершения.' };
  }

  const startsAtMs = startsAt ? startsAt.getTime() : Date.now();
  if (endsAt.getTime() <= startsAtMs) {
    return { valid: false, message: 'Завершение должно быть позже начала.' };
  }

  if (
    !Number.isInteger(draft.claimHours) ||
    draft.claimHours < MIN_CLAIM_HOURS ||
    draft.claimHours > MAX_CLAIM_HOURS
  ) {
    return {
      valid: false,
      message: `Срок подтверждения: от ${MIN_CLAIM_HOURS} до ${MAX_CLAIM_HOURS} часов.`,
    };
  }

  return { valid: true, message: '' };
}

function validateConditionsDraft(draft: GiveawayEditorDraft): GiveawayValidationResult {
  if (draft.requiredChannelIds.length > MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS) {
    return {
      valid: false,
      message: `Доп. каналов: максимум ${MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS}.`,
    };
  }

  const normalizedRequiredChannels = draft.requiredChannelIds.map((item) =>
    normalizeChannelId(item),
  );
  if (normalizedRequiredChannels.some((item) => !item)) {
    return { valid: false, message: 'Проверьте список доп. каналов.' };
  }

  if (
    new Set(normalizedRequiredChannels.map((item) => item.toLowerCase())).size !==
    normalizedRequiredChannels.length
  ) {
    return { valid: false, message: 'Доп. каналы не должны повторяться.' };
  }

  return { valid: true, message: '' };
}

function validatePrizesDraft(draft: GiveawayEditorDraft): GiveawayValidationResult {
  if (draft.prizes.length < 1 || draft.prizes.length > MANAGED_GIVEAWAY_MAX_PRIZES) {
    return { valid: false, message: `Количество мест: от 1 до ${MANAGED_GIVEAWAY_MAX_PRIZES}.` };
  }

  if (draft.prizeMode === 'same' && !draft.samePrizeTitle.trim()) {
    return { valid: false, message: 'Введите приз для всех мест.' };
  }

  const trimmedPrizes = draft.prizes.map((item) => item.trim());
  if (trimmedPrizes.some((item) => !item)) {
    return { valid: false, message: 'Заполните все призы.' };
  }

  return { valid: true, message: '' };
}

function validateMediaDraft(draft: GiveawayEditorDraft): GiveawayValidationResult {
  if (draft.imageEnabled && (!draft.imageBase64.trim() || !draft.imageMimeType.trim())) {
    return { valid: false, message: 'Не удалось использовать сохранённое изображение.' };
  }

  return { valid: true, message: '' };
}

function validateDraft(draft: GiveawayEditorDraft): GiveawayValidationResult {
  const basicValidation = validateBasicsDraft(draft);
  if (!basicValidation.valid) {
    return basicValidation;
  }

  const conditionsValidation = validateConditionsDraft(draft);
  if (!conditionsValidation.valid) {
    return conditionsValidation;
  }

  const prizesValidation = validatePrizesDraft(draft);
  if (!prizesValidation.valid) {
    return prizesValidation;
  }

  return validateMediaDraft(draft);
}

function resolveValidationFocusTarget(issue: {
  step: GiveawayEditorStepId;
  message: string;
}): GiveawayValidationFocusTarget {
  if (issue.step === 'conditions') {
    return 'channels';
  }

  if (issue.step === 'prizes') {
    return 'prizes';
  }

  if (issue.message.toLowerCase().includes('название')) {
    return 'title';
  }

  return 'endsAt';
}

function isFinishAtValidationMessage(message: string): boolean {
  return (
    message === 'Укажите дату и время завершения.' ||
    message === 'Проверьте дату завершения.' ||
    message === 'Завершение должно быть позже начала.'
  );
}

function areStringListsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((item, index) => item === right[index]);
}

function isDraftEqual(left: GiveawayEditorDraft, right: GiveawayEditorDraft): boolean {
  return (
    left.title === right.title &&
    left.description === right.description &&
    left.startsAtLocal === right.startsAtLocal &&
    left.endsAtLocal === right.endsAtLocal &&
    left.claimHours === right.claimHours &&
    left.prizeMode === right.prizeMode &&
    left.samePrizeTitle === right.samePrizeTitle &&
    left.imageEnabled === right.imageEnabled &&
    left.imageBase64 === right.imageBase64 &&
    left.imageMimeType === right.imageMimeType &&
    left.imageFileName === right.imageFileName &&
    areStringListsEqual(left.requiredChannelIds, right.requiredChannelIds) &&
    areStringListsEqual(left.prizes, right.prizes)
  );
}

function toUpdatePayload(draft: GiveawayEditorDraft): UpdateManagedGiveawayPayload {
  const startsAtDate = draft.startsAtLocal.trim() ? parseDateTimeInput(draft.startsAtLocal) : null;
  const endsAtDate = parseDateTimeInput(draft.endsAtLocal);
  if (!endsAtDate) {
    throw new Error('Проверьте дату завершения.');
  }
  if (draft.startsAtLocal.trim() && !startsAtDate) {
    throw new Error('Проверьте дату начала.');
  }

  return {
    title: draft.title.trim(),
    description: draft.description.trim(),
    imageEnabled: draft.imageEnabled,
    imageBase64: draft.imageBase64,
    imageMimeType: draft.imageMimeType,
    imageFileName: draft.imageFileName,
    startsAt: startsAtDate ? startsAtDate.toISOString() : null,
    endsAt: endsAtDate.toISOString(),
    claimHours: Math.max(MIN_CLAIM_HOURS, Math.min(MAX_CLAIM_HOURS, Math.round(draft.claimHours))),
    requiredChannelIds: Array.from(
      new Set(
        draft.requiredChannelIds
          .map((item) => normalizeChannelId(item))
          .filter((item) => item.length > 0),
      ),
    ),
    prizes: (draft.prizeMode === 'same'
      ? buildPrizeRowsFromSameTitle(draft.samePrizeTitle, draft.prizes.length)
      : draft.prizes
    ).map((title, index) => ({
      position: index + 1,
      title: title.trim(),
      displayTitle: title.trim(),
    })),
  };
}

function buildCurrentSubtitle(item: ManagedGiveawaySummary): string {
  if (item.status === 'DRAFT') {
    return `Черновик. Завершение: ${formatDateTime(item.endsAt)}.`;
  }
  if (item.status === 'SCHEDULED') {
    return `Начало: ${formatDateTime(item.startsAt, 'сразу')}. Завершение: ${formatDateTime(item.endsAt)}.`;
  }
  if (item.status === 'ACTIVE') {
    return `Идёт до ${formatDateTime(item.endsAt)}.`;
  }
  if (item.status === 'DRAWING') {
    return 'Подводим итоги.';
  }
  if (item.status === 'COMPLETED') {
    return `Обновлён: ${formatDateTime(item.completedAt ?? item.updatedAt)}.`;
  }
  return `Отменён: ${formatDateTime(item.updatedAt)}.`;
}

function buildWinnerStatusLabel(status: ManagedGiveawayWinner['status']): string {
  if (status === 'DELIVERED') {
    return 'Выдан';
  }
  if (status === 'CLAIMED') {
    return 'Ожидает выдачи';
  }
  if (status === 'SELECTED') {
    return 'Новый победитель';
  }
  if (status === 'EXPIRED') {
    return 'Нужен другой победитель';
  }
  return 'Архив';
}

function formatCompactMetricDate(value: string | null, fallback: string): string {
  if (!value) {
    return fallback;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return fallback;
  }

  return parsed.toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function ManagedGiveawayCardImpl(
  { api, entityType, entityId, onClosePanel }: ManagedGiveawayCardProps,
  ref: ForwardedRef<ManagedGiveawayCardHandle>,
) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [editorMode, setEditorMode] = useState<GiveawayEditorMode>('closed');
  const [selectedGiveawayId, setSelectedGiveawayId] = useState<string | null>(null);
  const [editingGiveawayId, setEditingGiveawayId] = useState<string | null>(null);
  const [draft, setDraft] = useState<GiveawayEditorDraft | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<GiveawayEditorDraft | null>(null);
  const [draftRevision, setDraftRevision] = useState<number | null>(null);
  const [revisionConflict, setRevisionConflict] = useState(false);
  const photoRequest = useRef<AbortController | null>(null);
  const [preparingPhoto, setPreparingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState('');
  const photoIssue = useRef(false);
  const clearPhotoWork = useCallback(() => {
    photoRequest.current?.abort();
    photoRequest.current = null;
    photoIssue.current = false;
    setPreparingPhoto(false);
    setPhotoError('');
  }, []);
  useEffect(() => () => photoRequest.current?.abort(), []);
  const [editorError, setEditorError] = useState('');
  const [validationHint, setValidationHint] = useState('');
  const [editorStep, setEditorStep] = useState<GiveawayEditorStepId>('basics');
  const [openHintKey, setOpenHintKey] = useState<GiveawayHintKey | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<GiveawayConfirmationAction | null>(
    null,
  );
  const [channelModalOpen, setChannelModalOpen] = useState(false);
  const [channelModalSelection, setChannelModalSelection] = useState<string[]>([]);
  const [channelLinkValue, setChannelLinkValue] = useState('');
  const [resolvedExternalChannels, setResolvedExternalChannels] = useState<
    Record<string, { title: string; link: string | null }>
  >({});
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const endDateInputRef = useRef<HTMLInputElement | null>(null);
  const channelLinkInputRef = useRef<HTMLInputElement | null>(null);
  const firstPrizeInputRef = useRef<HTMLInputElement | null>(null);
  const channelModalPanelRef = useRef<HTMLElement | null>(null);
  const channelModalReturnFocusRef = useRef<HTMLElement | null>(null);
  const editorHeadingRef = useRef<HTMLHeadingElement | null>(null);

  const listQueryKey = useMemo(
    () => queryKeys.managedGiveaways(entityType, entityId),
    [entityId, entityType],
  );

  const listQuery = useQuery({
    queryKey: listQueryKey,
    queryFn: () => getManagedGiveaways(api, entityType, entityId),
    enabled: Boolean(entityId),
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      query.state.data?.some((item) => ['ACTIVE', 'SCHEDULED', 'DRAWING'].includes(item.status))
        ? 15_000
        : false,
  });

  const sortedItems = useMemo(
    () =>
      [...(listQuery.data ?? [])].sort(
        (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
      ),
    [listQuery.data],
  );

  const currentItem = useMemo(
    () =>
      sortedItems.find(
        (item) =>
          item.status === 'DRAFT' ||
          item.status === 'SCHEDULED' ||
          item.status === 'ACTIVE' ||
          item.status === 'DRAWING',
      ) ?? null,
    [sortedItems],
  );
  const featuredItem =
    sortedItems.find((item) => item.id === selectedGiveawayId) ??
    currentItem ??
    sortedItems[0] ??
    null;
  const featuredGiveawayId = featuredItem?.id ?? null;

  const draftDetailsQuery = useQuery({
    queryKey: queryKeys.managedGiveawayDetails(entityType, entityId, editingGiveawayId),
    queryFn: () => {
      if (!editingGiveawayId) {
        throw new Error('Черновик не выбран.');
      }
      return getManagedGiveaway(api, entityType, entityId, editingGiveawayId);
    },
    enabled: editorMode === 'edit' && Boolean(entityId) && Boolean(editingGiveawayId),
    refetchOnWindowFocus: false,
  });

  const featuredDetailsQuery = useQuery({
    queryKey: queryKeys.managedGiveawayDetails(entityType, entityId, featuredGiveawayId),
    queryFn: () => {
      if (!featuredGiveawayId) {
        throw new Error('Розыгрыш не выбран.');
      }
      return getManagedGiveaway(api, entityType, entityId, featuredGiveawayId);
    },
    enabled: editorMode === 'closed' && Boolean(entityId) && Boolean(featuredGiveawayId),
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      if (featuredItem?.status === 'DRAWING') return 5_000;
      if (featuredItem?.status !== 'COMPLETED') return false;
      const details = query.state.data;
      return details?.status !== 'COMPLETED' ||
        details.winners.some(
          (winner) => winner.status === 'SELECTED' || winner.status === 'CLAIMED',
        )
        ? 15_000
        : false;
    },
  });

  const channelsQuery = useQuery({
    queryKey: queryKeys.giveawayOwnedChannels,
    queryFn: () => getChannels(api),
    enabled: editorMode !== 'closed',
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    const details = draftDetailsQuery.data;
    if (!details || details.id !== editingGiveawayId || editorMode !== 'edit' || savedSnapshot)
      return;
    const nextDraft = toEditorDraft(details);
    setDraft(nextDraft);
    setSavedSnapshot(nextDraft);
    setDraftRevision(details.draftRevision ?? null);
    setEditorError('');
    setValidationHint('');
  }, [draftDetailsQuery.data, editingGiveawayId, editorMode, savedSnapshot]);

  useEffect(() => {
    setOpenHintKey(null);
  }, [editorMode, editorStep]);

  useEffect(() => {
    if (editorMode !== 'edit' && editorMode !== 'create') {
      setChannelModalOpen(false);
      return;
    }

    if (editorStep !== 'conditions') {
      setChannelModalOpen(false);
    }
  }, [editorMode, editorStep]);

  useEffect(() => {
    if (!openHintKey || typeof document === 'undefined') {
      return undefined;
    }

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (target.closest('.managed-giveaway__hint-anchor')) {
        return;
      }
      setOpenHintKey(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenHintKey(null);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown, { passive: true });
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [openHintKey]);

  useHintPopoverAutoPosition(openHintKey !== null, openHintKey);

  useEffect(() => {
    if (!channelModalOpen || typeof window === 'undefined') {
      return undefined;
    }

    window.requestAnimationFrame(() => {
      channelModalPanelRef.current?.focus({ preventScroll: true });
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setChannelModalOpen(false);
        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const panel = channelModalPanelRef.current;
      if (!panel) {
        return;
      }

      const focusableElements = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute('aria-hidden'));
      const firstElement = focusableElements[0];
      const lastElement = focusableElements.at(-1);

      if (!firstElement || !lastElement) {
        event.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }

      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [channelModalOpen]);

  useEffect(() => {
    if (channelModalOpen || typeof window === 'undefined') {
      return;
    }

    const target = channelModalReturnFocusRef.current;
    channelModalReturnFocusRef.current = null;
    if (!target) {
      return;
    }

    window.requestAnimationFrame(() => {
      target.focus({ preventScroll: true });
    });
  }, [channelModalOpen]);

  const toggleHint = (hintKey: GiveawayHintKey) => {
    setOpenHintKey((current) => (current === hintKey ? null : hintKey));
  };

  const isDirty =
    editorMode === 'edit'
      ? Boolean(draft && savedSnapshot && !isDraftEqual(draft, savedSnapshot))
      : true;
  const hasUnsavedEditorChanges = Boolean(
    draft && savedSnapshot && !isDraftEqual(draft, savedSnapshot),
  );
  const blankValidation = useMemo<GiveawayValidationResult>(
    () => ({ valid: false, message: 'Черновик не заполнен.' }),
    [],
  );
  const basicsValidation = useMemo(
    () => (draft ? validateBasicsDraft(draft) : blankValidation),
    [blankValidation, draft],
  );
  const conditionsValidation = useMemo(
    () => (draft ? validateConditionsDraft(draft) : blankValidation),
    [blankValidation, draft],
  );
  const prizesValidation = useMemo(
    () => (draft ? validatePrizesDraft(draft) : blankValidation),
    [blankValidation, draft],
  );
  const mediaValidation = useMemo(
    () => (draft ? validateMediaDraft(draft) : blankValidation),
    [blankValidation, draft],
  );
  const validation = useMemo(
    () => (draft ? validateDraft(draft) : blankValidation),
    [blankValidation, draft],
  );

  const ownedChannels = useMemo(
    () => (channelsQuery.data ?? []).filter((item) => item.entityType === 'channel'),
    [channelsQuery.data],
  );

  const channelById = useMemo(() => {
    const map = new Map<string, ChatSummary>();
    for (const channel of ownedChannels) {
      map.set(channel.id, channel);
    }
    return map;
  }, [ownedChannels]);

  const selectedRequiredChannels = useMemo(() => {
    if (!draft) {
      return [];
    }
    return draft.requiredChannelIds.map((channelId) => {
      const channel = channelById.get(channelId);
      const fresh = resolvedExternalChannels[channelId];
      const saved = draftDetailsQuery.data?.requiredChannels?.find((item) => item.id === channelId);
      return {
        id: channelId,
        title:
          channel?.title?.trim() ||
          fresh?.title?.trim() ||
          saved?.title?.trim() ||
          'Канал из условий',
        link: channel?.link ?? fresh?.link ?? saved?.link ?? null,
      };
    });
  }, [channelById, draft, resolvedExternalChannels, draftDetailsQuery.data]);

  const ownedSelectableChannels = useMemo(
    () => ownedChannels.filter((channel) => channel.id !== entityId),
    [entityId, ownedChannels],
  );

  const selectedOwnedChannelIds = useMemo(() => {
    if (!draft) {
      return [];
    }

    const selected = new Set(draft.requiredChannelIds);
    return ownedSelectableChannels
      .filter((channel) => selected.has(channel.id))
      .map((channel) => channel.id);
  }, [draft, ownedSelectableChannels]);

  const editorSteps = useMemo(
    () =>
      GIVEAWAY_EDITOR_STEPS.map((step) => {
        if (step.id === 'basics') {
          return {
            ...step,
            isComplete: basicsValidation.valid,
          };
        }
        if (step.id === 'conditions') {
          return {
            ...step,
            isComplete: conditionsValidation.valid,
          };
        }
        return {
          ...step,
          isComplete: prizesValidation.valid,
        };
      }),
    [basicsValidation.valid, conditionsValidation.valid, prizesValidation.valid],
  );
  const activeEditorStepIndex = Math.max(
    0,
    editorSteps.findIndex((item) => item.id === editorStep),
  );
  const activeEditorStep = editorSteps[activeEditorStepIndex] ?? editorSteps[0];
  const currentStepValidation =
    editorStep === 'basics'
      ? basicsValidation
      : editorStep === 'conditions'
        ? conditionsValidation
        : prizesValidation;
  const finishAtValidationError =
    !basicsValidation.valid && isFinishAtValidationMessage(validationHint) ? validationHint : '';
  const firstConfigIssue = !basicsValidation.valid
    ? { step: 'basics' as GiveawayEditorStepId, message: basicsValidation.message }
    : !conditionsValidation.valid
      ? { step: 'conditions' as GiveawayEditorStepId, message: conditionsValidation.message }
      : !prizesValidation.valid
        ? { step: 'prizes' as GiveawayEditorStepId, message: prizesValidation.message }
        : !mediaValidation.valid
          ? { step: 'prizes' as GiveawayEditorStepId, message: mediaValidation.message }
          : null;
  const createMutation = useMutation({
    mutationFn: (payload: UpdateManagedGiveawayPayload) =>
      createManagedGiveaway(api, entityType, entityId, payload),
  });

  const updateMutation = useMutation({
    mutationFn: (params: {
      giveawayId: string;
      payload: UpdateManagedGiveawayPayload;
      expectedRevision: number;
    }) =>
      updateManagedGiveaway(
        api,
        entityType,
        entityId,
        params.giveawayId,
        params.payload,
        params.expectedRevision,
      ),
  });

  const publishMutation = useMutation({
    mutationFn: (params: { giveawayId: string; expectedRevision: number }) =>
      publishManagedGiveaway(api, entityType, entityId, params.giveawayId, params.expectedRevision),
  });

  const cancelMutation = useMutation({
    mutationFn: (giveawayId: string) =>
      cancelManagedGiveaway(api, entityType, entityId, giveawayId),
  });

  const resolveRequiredChannelMutation = useMutation({
    mutationFn: (value: string) =>
      resolveManagedGiveawayRequiredChannel(api, entityType, entityId, value),
  });

  const refreshPublicationMutation = useMutation({
    mutationFn: (giveawayId: string) =>
      refreshManagedGiveawayPublication(api, entityType, entityId, giveawayId),
    onSuccess: () => {
      void refetchManagedGiveaways();
      pushToast({ tone: 'success', title: 'Итоги обновлены в MAX' });
    },
    onError: (error) => {
      const message = formatApiError(error, 'Не удалось обновить итоги.');
      if (
        error instanceof ApiRequestError &&
        error.status === 409 &&
        (error.code === 'GIVEAWAY_RESULTS_SYNC_PENDING' ||
          message === 'Итоги ожидают обновления в MAX.')
      ) {
        pushToast({ tone: 'info', title: 'Итоги ожидают обновления в MAX' });
        return;
      }
      pushToast({ tone: 'danger', title: 'Не удалось обновить итоги', description: message });
    },
  });

  const closeMutation = useMutation({
    mutationFn: (giveawayId: string) => closeManagedGiveaway(api, entityType, entityId, giveawayId),
  });

  const rerollMutation = useMutation({
    mutationFn: (params: { giveawayId: string; winnerId: string }) =>
      rerollManagedGiveawayWinner(api, entityType, entityId, params.giveawayId, params.winnerId),
  });

  const deliverMutation = useMutation({
    mutationFn: (params: { giveawayId: string; winnerId: string }) =>
      markManagedGiveawayWinnerDelivered(
        api,
        entityType,
        entityId,
        params.giveawayId,
        params.winnerId,
      ),
  });

  const deleteMutation = useMutation({
    mutationFn: (giveawayId: string) =>
      deleteManagedGiveaway(api, entityType, entityId, giveawayId),
  });

  const isBusy =
    createMutation.isPending ||
    updateMutation.isPending ||
    publishMutation.isPending ||
    cancelMutation.isPending ||
    resolveRequiredChannelMutation.isPending ||
    closeMutation.isPending ||
    refreshPublicationMutation.isPending ||
    rerollMutation.isPending ||
    deliverMutation.isPending ||
    deleteMutation.isPending;

  const clearEditor = useCallback(() => {
    clearPhotoWork();
    setDraftRevision(null);
    setRevisionConflict(false);
    setPendingConfirmation(null);
    setEditorMode('closed');
    setEditingGiveawayId(null);
    setDraft(null);
    setSavedSnapshot(null);
    setEditorError('');
    setValidationHint('');
    setEditorStep('basics');
    setChannelModalOpen(false);
    setChannelModalSelection([]);
    setChannelLinkValue('');
    setResolvedExternalChannels({});
  }, [clearPhotoWork]);

  const applyEditorPayload = (giveaway: ManagedGiveawayDetails) => {
    const nextDraft = toEditorDraft(giveaway);
    setDraftRevision(giveaway.draftRevision ?? null);
    setRevisionConflict(false);
    clearPhotoWork();
    setEditorMode('edit');
    setEditingGiveawayId(giveaway.id);
    setDraft(nextDraft);
    setSavedSnapshot(nextDraft);
    setEditorError('');
    setValidationHint('');
    setChannelModalOpen(false);
    setChannelModalSelection([]);
    setChannelLinkValue('');
  };

  const startCreate = () => {
    setEditorMode('create');
    const nextDraft = createDefaultEditorDraft();
    setDraft(nextDraft);
    setSavedSnapshot(nextDraft);
    setEditingGiveawayId(null);
    setEditorError('');
    setValidationHint('');
    setEditorStep('basics');
    setChannelModalOpen(false);
    setChannelModalSelection([]);
    setChannelLinkValue('');
    setResolvedExternalChannels({});
  };

  const startEditCurrentDraft = () => {
    if (!currentItem || currentItem.status !== 'DRAFT') {
      return;
    }
    setEditorMode('edit');
    setEditingGiveawayId(currentItem.id);
    setEditorError('');
    setValidationHint('');
    setEditorStep('basics');
    setChannelModalOpen(false);
    setChannelModalSelection([]);
    setChannelLinkValue('');
  };

  const updateDraft = (updater: (current: GiveawayEditorDraft) => GiveawayEditorDraft) => {
    setDraft((current) => (current ? updater(current) : current));
    setValidationHint('');
    setEditorError('');
  };

  const clearPublicationImage = () => {
    clearPhotoWork();
    updateDraft((current) => ({
      ...current,
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
    }));
  };

  const handlePublicationImageChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }

    clearPhotoWork();
    const request = new AbortController();
    photoRequest.current = request;
    setPreparingPhoto(true);
    try {
      const { prepareBroadcastImage } = await import('../lib/broadcast-image');
      const prepared = await prepareBroadcastImage(file, { signal: request.signal });
      if (photoRequest.current !== request || request.signal.aborted) return;
      updateDraft((current) => ({
        ...current,
        imageEnabled: true,
        imageBase64: prepared.base64,
        imageMimeType: prepared.mimeType,
        imageFileName: prepared.fileName,
      }));
    } catch (error: unknown) {
      if (photoRequest.current !== request || request.signal.aborted) return;
      const message =
        error instanceof Error && error.message.trim()
          ? error.message
          : 'Не удалось подготовить фото.';
      photoIssue.current = true;
      setPhotoError(message);
    } finally {
      if (photoRequest.current === request && !request.signal.aborted) {
        photoRequest.current = null;
        setPreparingPhoto(false);
      }
    }
  };

  const toggleStartMode = (nextMode: 'instant' | 'scheduled') => {
    updateDraft((current) => {
      if (nextMode === 'instant') {
        return {
          ...current,
          startsAtLocal: '',
        };
      }

      const suggestedStart =
        parseDateTimeInput(current.startsAtLocal) ?? roundToNextQuarter(new Date());
      const suggestedEnd = parseDateTimeInput(current.endsAtLocal);
      const normalizedEnd =
        suggestedEnd && suggestedEnd.getTime() > suggestedStart.getTime()
          ? current.endsAtLocal
          : formatDateTimeInputValue(addHours(suggestedStart, 24));

      return {
        ...current,
        startsAtLocal: formatDateTimeInputValue(suggestedStart),
        endsAtLocal: normalizedEnd,
      };
    });
  };

  const updateStartDate = (nextDate: string) => {
    updateDraft((current) => {
      const fallback = parseDateTimeInput(current.startsAtLocal) ?? roundToNextQuarter(new Date());
      return {
        ...current,
        startsAtLocal: mergeDateAndTime(
          nextDate,
          readTimeInputPart(current.startsAtLocal, formatTimeInputValue(fallback)),
          fallback,
        ),
      };
    });
  };

  const updateStartTime = (nextTime: string) => {
    updateDraft((current) => {
      const fallback = parseDateTimeInput(current.startsAtLocal) ?? roundToNextQuarter(new Date());
      const dateValue = readDateInputPart(current.startsAtLocal) || formatDateInputValue(fallback);
      return {
        ...current,
        startsAtLocal: mergeDateAndTime(dateValue, nextTime, fallback),
      };
    });
  };

  const updateEndDate = (nextDate: string) => {
    updateDraft((current) => {
      const fallback =
        parseDateTimeInput(current.endsAtLocal) ??
        addHours(parseDateTimeInput(current.startsAtLocal) ?? new Date(), 24);
      return {
        ...current,
        endsAtLocal: mergeDateAndTime(
          nextDate,
          readTimeInputPart(current.endsAtLocal, formatTimeInputValue(fallback)),
          fallback,
        ),
      };
    });
  };

  const updateEndTime = (nextTime: string) => {
    updateDraft((current) => {
      const fallback =
        parseDateTimeInput(current.endsAtLocal) ??
        addHours(parseDateTimeInput(current.startsAtLocal) ?? new Date(), 24);
      const dateValue = readDateInputPart(current.endsAtLocal) || formatDateInputValue(fallback);
      return {
        ...current,
        endsAtLocal: mergeDateAndTime(dateValue, nextTime, fallback),
      };
    });
  };

  const applyFinishPreset = (hours: number) => {
    updateDraft((current) => {
      const base = parseDateTimeInput(current.startsAtLocal) ?? new Date();
      const nextEnd = addHours(base, hours);
      nextEnd.setSeconds(0, 0);
      return {
        ...current,
        endsAtLocal: formatDateTimeInputValue(nextEnd),
      };
    });
  };

  const openOwnedChannelsModal = (event?: ReactMouseEvent<HTMLElement>) => {
    if (typeof document !== 'undefined') {
      channelModalReturnFocusRef.current =
        event?.currentTarget ??
        (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    }
    setChannelModalSelection(selectedOwnedChannelIds);
    setChannelModalOpen(true);
    setValidationHint('');
    setEditorError('');
  };

  const applyOwnedChannelsSelection = () => {
    const nextSelection = new Set(channelModalSelection);
    const ownedChannelIds = new Set(ownedSelectableChannels.map((channel) => channel.id));

    setDraft((current) => {
      if (!current) {
        return current;
      }

      const externalRequiredChannelIds = current.requiredChannelIds.filter(
        (channelId) => !ownedChannelIds.has(channelId),
      );
      const nextOwnedChannelIds = ownedSelectableChannels
        .map((channel) => channel.id)
        .filter((channelId) => nextSelection.has(channelId));

      return {
        ...current,
        requiredChannelIds: [...externalRequiredChannelIds, ...nextOwnedChannelIds],
      };
    });

    setChannelModalOpen(false);
    setValidationHint('');
    setEditorError('');
  };

  const addRequiredChannelById = (channelId: string) => {
    const normalizedChannelId = normalizeChannelId(channelId);
    if (!normalizedChannelId || normalizedChannelId === entityId) {
      return;
    }
    if ((draft?.requiredChannelIds.length ?? 0) >= MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS) {
      setValidationHint(`Доп. каналов: максимум ${MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS}.`);
      return;
    }

    setDraft((current) => {
      if (!current) {
        return current;
      }

      if (current.requiredChannelIds.includes(normalizedChannelId)) {
        return current;
      }

      return {
        ...current,
        requiredChannelIds: [...current.requiredChannelIds, normalizedChannelId],
      };
    });
    setChannelLinkValue('');
    setValidationHint('');
    setEditorError('');
  };

  const removeRequiredChannelById = (channelId: string) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            requiredChannelIds: current.requiredChannelIds.filter((item) => item !== channelId),
          }
        : current,
    );
    setValidationHint('');
    setEditorError('');
  };

  const addRequiredChannelByLink = async () => {
    const normalized = normalizeChannelLink(channelLinkValue);
    if (!normalized) {
      setValidationHint('Вставьте ссылку канала.');
      return;
    }
    if ((draft?.requiredChannelIds.length ?? 0) >= MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS) {
      setValidationHint(`Доп. каналов: максимум ${MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS}.`);
      return;
    }

    try {
      const result = await resolveRequiredChannelMutation.mutateAsync(channelLinkValue);
      const channel = result.channel;
      if (channel.id === entityId) {
        setValidationHint('Этот чат или канал уже входит в условия розыгрыша.');
        return;
      }
      if (draft?.requiredChannelIds.includes(channel.id)) {
        setValidationHint('Канал уже добавлен в условия.');
        return;
      }

      setResolvedExternalChannels((current) => ({
        ...current,
        [channel.id]: {
          title: channel.title,
          link: channel.link ?? null,
        },
      }));
      addRequiredChannelById(channel.id);
      pushToast({
        tone: 'success',
        title: 'Канал добавлен',
        description: channel.title,
      });
    } catch (error: unknown) {
      const message = formatApiError(error, 'Не удалось проверить ссылку канала.');
      setValidationHint(message);
      pushToast({
        tone: 'danger',
        title: 'Не удалось добавить канал',
        description: message,
      });
    }
  };

  const refetchManagedGiveaways = async () => {
    await Promise.all([
      listQuery.refetch(),
      queryClient.invalidateQueries({
        queryKey: queryKeys.managedGiveawayDetailsScope(entityType, entityId),
      }),
    ]);
  };

  const openManagedGiveawayLink = (url: string | null) => {
    const targetUrl = url?.trim() ?? '';
    if (!targetUrl || typeof window === 'undefined') {
      return;
    }

    if (window.MAX?.WebApp ?? window.WebApp) {
      maxSelectionChanged();
      openMaxBotLink(targetUrl);
      return;
    }

    window.open(targetUrl, '_blank', 'noopener,noreferrer');
  };

  const shareManagedGiveawayLink = async (url: string | null, label: string) => {
    const targetUrl = url?.trim() ?? '';
    if (!targetUrl) {
      return;
    }

    try {
      maxSelectionChanged();
      await shareNativeContent({
        text: label,
        link: targetUrl,
        preferMax: true,
      });
      maxNotify('success');
    } catch {
      openManagedGiveawayLink(targetUrl);
    }
  };

  const closeFeaturedGiveaway = async (giveawayId: string): Promise<boolean> => {
    if (!giveawayId) {
      return false;
    }

    try {
      await closeMutation.mutateAsync(giveawayId);
      await refetchManagedGiveaways();
      pushToast({
        tone: 'success',
        title: 'Розыгрыш завершён',
      });
      return true;
    } catch (error: unknown) {
      pushToast({
        tone: 'danger',
        title: 'Не удалось завершить розыгрыш',
        description: formatApiError(error, 'Не удалось завершить розыгрыш.'),
      });
      return false;
    }
  };

  const rerollFeaturedWinner = async (giveawayId: string, winnerId: string): Promise<boolean> => {
    if (!giveawayId || !winnerId) {
      return false;
    }

    try {
      await rerollMutation.mutateAsync({
        giveawayId,
        winnerId,
      });
      await refetchManagedGiveaways();
      pushToast({
        tone: 'success',
        title: 'Выбран другой победитель',
      });
      return true;
    } catch (error: unknown) {
      pushToast({
        tone: 'danger',
        title: 'Не удалось выбрать другого победителя',
        description: formatApiError(error, 'Не удалось выбрать другого победителя.'),
      });
      return false;
    }
  };

  const markFeaturedWinnerDelivered = async (
    giveawayId: string,
    winnerId: string,
  ): Promise<boolean> => {
    if (!giveawayId || !winnerId) {
      return false;
    }

    try {
      await deliverMutation.mutateAsync({
        giveawayId,
        winnerId,
      });
      await refetchManagedGiveaways();
      pushToast({
        tone: 'success',
        title: 'Выдача отмечена',
      });
      return true;
    } catch (error: unknown) {
      pushToast({
        tone: 'danger',
        title: 'Не удалось отметить выдачу',
        description: formatApiError(error, 'Не удалось отметить выдачу.'),
      });
      return false;
    }
  };

  const deleteFeaturedGiveaway = async (giveawayId: string): Promise<boolean> => {
    if (!giveawayId) {
      return false;
    }

    try {
      await deleteMutation.mutateAsync(giveawayId);
      await refetchManagedGiveaways();
      pushToast({
        tone: 'success',
        title: 'Розыгрыш в архиве',
      });
      return true;
    } catch (error: unknown) {
      pushToast({
        tone: 'danger',
        title: 'Не удалось архивировать розыгрыш',
        description: formatApiError(error, 'Не удалось архивировать розыгрыш.'),
      });
      return false;
    }
  };

  const checkedRevision = (revision: number | null | undefined) => {
    if (!revision) throw new ApiRequestError(409, '', 'Откройте актуальную версию черновика.');
    return revision;
  };

  const saveEditor = async ({
    silent = false,
  }: {
    silent?: boolean;
  } = {}): Promise<ManagedGiveawayDetails | null> => {
    if (!draft || photoRequest.current || photoIssue.current || revisionConflict) {
      return null;
    }

    const checked = validateDraft(draft);
    if (!checked.valid) {
      setValidationHint(checked.message);
      const targetStep = !basicsValidation.valid
        ? 'basics'
        : !conditionsValidation.valid
          ? 'conditions'
          : 'prizes';
      focusEditorTarget(
        resolveValidationFocusTarget({
          step: targetStep,
          message: checked.message,
        }),
      );
      if (!silent) {
        pushToast({
          tone: 'danger',
          title: 'Проверьте поля',
          description: checked.message,
        });
      }
      return null;
    }

    try {
      const nextPayload = toUpdatePayload(draft);
      const payload = {
        ...nextPayload,
        requiredChannelIds: nextPayload.requiredChannelIds.filter((item) => item !== entityId),
      };
      const saved =
        editorMode === 'create' || !editingGiveawayId
          ? await createMutation.mutateAsync(payload)
          : await updateMutation.mutateAsync({
              giveawayId: editingGiveawayId,
              payload,
              expectedRevision: checkedRevision(draftRevision),
            });

      applyEditorPayload(saved);
      await refetchManagedGiveaways();
      if (!silent) {
        pushToast({
          tone: 'success',
          title: editorMode === 'create' ? 'Черновик создан' : 'Черновик сохранён',
        });
      }
      return saved;
    } catch (error: unknown) {
      if (error instanceof ApiRequestError && error.status === 409 && editingGiveawayId)
        setRevisionConflict(true);
      const message = formatApiError(error, 'Не удалось сохранить черновик.');
      setEditorError(message);
      if (!silent) {
        pushToast({
          tone: 'danger',
          title: 'Не удалось сохранить',
          description: message,
        });
      }
      return null;
    }
  };

  const publishEditor = async () => {
    if (!draft || photoRequest.current || photoIssue.current || revisionConflict) {
      return;
    }

    if (firstConfigIssue) {
      showEditorIssue(firstConfigIssue, 'Закончите настройку');
      return;
    }

    if (!draft.description.trim()) {
      const message = 'Добавьте текст публикации перед запуском розыгрыша.';
      setEditorStep('prizes');
      setValidationHint(message);
      pushToast({
        tone: 'danger',
        title: 'Нужен текст публикации',
        description: message,
      });
      return;
    }

    const checked = validateDraft(draft);
    if (!checked.valid) {
      setValidationHint(checked.message);
      focusEditorTarget(
        resolveValidationFocusTarget({
          step: 'prizes',
          message: checked.message,
        }),
      );
      pushToast({
        tone: 'danger',
        title: 'Проверьте поля',
        description: checked.message,
      });
      return;
    }

    try {
      let targetId = editingGiveawayId;
      let expectedRevision = draftRevision;

      if (editorMode === 'create' || !targetId) {
        const created = await saveEditor({ silent: true });
        if (!created) {
          return;
        }
        targetId = created.id;
        expectedRevision = created.draftRevision ?? null;
      } else if (isDirty) {
        const updated = await saveEditor({ silent: true });
        if (!updated) {
          return;
        }
        targetId = updated.id;
        expectedRevision = updated.draftRevision ?? null;
      }

      if (!targetId) {
        throw new Error('Черновик не найден.');
      }

      await publishMutation.mutateAsync({
        giveawayId: targetId,
        expectedRevision: checkedRevision(expectedRevision),
      });
      await refetchManagedGiveaways();
      clearEditor();
      pushToast({
        tone: 'success',
        title: 'Розыгрыш опубликован',
      });
    } catch (error: unknown) {
      if (error instanceof ApiRequestError && error.status === 409) setRevisionConflict(true);
      const message = formatApiError(error, 'Не удалось опубликовать розыгрыш.');
      setEditorError(message);
      pushToast({
        tone: 'danger',
        title: 'Не удалось опубликовать',
        description: message,
      });
    }
  };

  const setPrizeCount = (nextCount: number) => {
    const normalizedCount = Math.max(1, Math.min(MANAGED_GIVEAWAY_MAX_PRIZES, nextCount));
    setDraft((current) => {
      if (!current || current.prizes.length === normalizedCount) {
        return current;
      }

      if (current.prizes.length > normalizedCount) {
        return {
          ...current,
          prizes: current.prizes.slice(0, normalizedCount),
        };
      }

      const lastFilledPrize =
        current.prizeMode === 'same'
          ? current.samePrizeTitle
          : ([...current.prizes].reverse().find((item) => item.trim()) ?? '');
      const extraPrizes = Array.from(
        { length: normalizedCount - current.prizes.length },
        () => lastFilledPrize,
      );
      return {
        ...current,
        prizes: [...current.prizes, ...extraPrizes],
      };
    });
    setValidationHint('');
    setEditorError('');
  };

  const setPrizeMode = (nextMode: GiveawayPrizeMode) => {
    updateDraft((current) => {
      if (current.prizeMode === nextMode) {
        return current;
      }

      const repeatedTitle =
        current.samePrizeTitle.trim() ||
        resolveRepeatedPrizeTitle(current.prizes) ||
        current.prizes.find((item) => item.trim())?.trim() ||
        '';

      if (nextMode === 'same') {
        return {
          ...current,
          prizeMode: 'same',
          samePrizeTitle: repeatedTitle,
          prizes: buildPrizeRowsFromSameTitle(repeatedTitle, current.prizes.length),
        };
      }

      return {
        ...current,
        prizeMode: 'different',
        samePrizeTitle: repeatedTitle,
        prizes: current.prizes.map((item) => item || repeatedTitle),
      };
    });
  };

  const goToPreviousStep = () => {
    if (activeEditorStepIndex <= 0) {
      return;
    }
    setValidationHint('');
    setEditorStep(editorSteps[activeEditorStepIndex - 1]?.id ?? 'basics');
  };

  const goToNextStep = () => {
    if (activeEditorStepIndex >= editorSteps.length - 1) {
      return;
    }
    if (!currentStepValidation.valid) {
      showEditorIssue(
        {
          step: editorStep,
          message: currentStepValidation.message,
        },
        'Проверьте шаг',
      );
      return;
    }

    setValidationHint('');
    setEditorStep(editorSteps[activeEditorStepIndex + 1]?.id ?? 'publish');
  };

  const handleFinalPrimaryAction = () => {
    if (photoRequest.current || photoIssue.current || revisionConflict) return;
    if (firstConfigIssue) {
      showEditorIssue(firstConfigIssue, 'Закончите настройку');
      return;
    }

    if (!publicationTextReady) {
      setEditorStep('prizes');
      const message = 'Добавьте текст публикации и при необходимости фото прямо в этом шаге.';
      setValidationHint(message);
      pushToast({
        tone: 'danger',
        title: 'Нужен текст публикации',
        description: message,
      });
      return;
    }

    setPendingConfirmation({ kind: 'publish' });
  };

  const cancelEditorDraft = async (giveawayId: string): Promise<boolean> => {
    if (!giveawayId) {
      return false;
    }

    try {
      await cancelMutation.mutateAsync(giveawayId);
      await refetchManagedGiveaways();
      clearEditor();
      pushToast({
        tone: 'success',
        title: 'Черновик отменён',
      });
      return true;
    } catch (error: unknown) {
      const message = formatApiError(error, 'Не удалось отменить черновик.');
      setEditorError(message);
      pushToast({
        tone: 'danger',
        title: 'Не удалось отменить черновик',
        description: message,
      });
      return false;
    }
  };

  const requestCloseEditor = () => {
    if (isBusy) {
      return;
    }

    if (hasUnsavedEditorChanges) {
      setPendingConfirmation({ kind: 'discard-editor', origin: 'back' });
      return;
    }

    clearEditor();
  };

  const requestCancelEditorDraft = () => {
    if (isBusy) {
      return;
    }

    if (editorMode === 'edit' && editingGiveawayId) {
      setPendingConfirmation({ kind: 'cancel-draft', giveawayId: editingGiveawayId });
      return;
    }

    if (hasUnsavedEditorChanges) {
      setPendingConfirmation({ kind: 'discard-editor', origin: 'reset' });
      return;
    }

    clearEditor();
  };

  const requestCloseFeaturedGiveaway = () => {
    if (!featuredItem || isBusy) {
      return;
    }

    setPendingConfirmation({
      kind: 'close',
      giveawayId: featuredItem.id,
      title: featuredItem.title.trim() || 'Этот розыгрыш',
    });
  };

  const requestRerollFeaturedWinner = (winner: ManagedGiveawayWinner) => {
    if (!featuredItem || isBusy) {
      return;
    }

    setPendingConfirmation({
      kind: 'reroll',
      giveawayId: featuredItem.id,
      winnerId: winner.id,
      winnerName: winner.displayName?.trim() || 'текущий победитель',
    });
  };

  const requestMarkFeaturedWinnerDelivered = (winner: ManagedGiveawayWinner) => {
    if (!featuredItem || isBusy) {
      return;
    }

    setPendingConfirmation({
      kind: 'deliver',
      giveawayId: featuredItem.id,
      winnerId: winner.id,
      winnerName: winner.displayName?.trim() || 'победитель',
    });
  };

  const requestDeleteFeaturedGiveaway = () => {
    if (!featuredItem || isBusy) {
      return;
    }

    setPendingConfirmation({
      kind: 'delete',
      giveawayId: featuredItem.id,
      title: featuredItem.title.trim() || 'Этот розыгрыш',
    });
  };

  const confirmPendingAction = async () => {
    const action = pendingConfirmation;
    if (!action || isBusy) {
      return;
    }

    if (action.kind === 'publish') {
      await publishEditor();
      setPendingConfirmation(null);
      return;
    }

    if (action.kind === 'discard-editor') {
      const closePanel = action.closePanel === true;
      clearEditor();
      if (closePanel) {
        onClosePanel();
      }
      return;
    }

    if (action.kind === 'cancel-draft') {
      if (await cancelEditorDraft(action.giveawayId)) {
        setPendingConfirmation(null);
      }
      return;
    }

    if (action.kind === 'close') {
      if (await closeFeaturedGiveaway(action.giveawayId)) {
        setPendingConfirmation(null);
      }
      return;
    }

    if (action.kind === 'reroll') {
      if (await rerollFeaturedWinner(action.giveawayId, action.winnerId)) {
        setPendingConfirmation(null);
      }
      return;
    }

    if (action.kind === 'deliver') {
      if (await markFeaturedWinnerDelivered(action.giveawayId, action.winnerId)) {
        setPendingConfirmation(null);
      }
      return;
    }

    if (await deleteFeaturedGiveaway(action.giveawayId)) {
      setPendingConfirmation(null);
    }
  };

  const saveAndCloseEditor = async () => {
    if (!validation.valid || isBusy) {
      return;
    }

    const closePanel =
      pendingConfirmation?.kind === 'discard-editor' && pendingConfirmation.closePanel === true;
    const saved = await saveEditor();
    if (!saved) {
      return;
    }

    clearEditor();
    if (closePanel) {
      onClosePanel();
    }
  };

  const isEditingOpen = editorMode !== 'closed';
  useEffect(() => {
    if (!isEditingOpen) return;
    const heading = editorHeadingRef.current;
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }, [editorStep, isEditingOpen]);
  useImperativeHandle(
    ref,
    () => ({
      requestClose: () => {
        if (isBusy || pendingConfirmation) {
          return false;
        }

        if (!isEditingOpen) {
          return true;
        }

        if (hasUnsavedEditorChanges) {
          setPendingConfirmation({ kind: 'discard-editor', origin: 'back', closePanel: true });
          return false;
        }

        clearEditor();
        return true;
      },
    }),
    [clearEditor, hasUnsavedEditorChanges, isBusy, isEditingOpen, pendingConfirmation],
  );
  useEffect(() => {
    void import('./ui/action-confirm-sheet');
  }, []);
  useNativeBackHandler(
    () => {
      setOpenHintKey(null);
      return true;
    },
    { enabled: openHintKey !== null, priority: 520 },
  );
  useNativeBackHandler(
    () => {
      setChannelModalOpen(false);
      return true;
    },
    { enabled: channelModalOpen, priority: 650 },
  );
  useNativeBackHandler(
    () => {
      if (isBusy) {
        return true;
      }

      requestCloseEditor();
      return true;
    },
    { enabled: isEditingOpen && pendingConfirmation === null, priority: 640 },
  );
  const publicationTextReady = Boolean(draft?.description.trim());
  const draftActionBlocked = Boolean(preparingPhoto || photoError || revisionConflict);
  const canSaveEditor =
    !draftActionBlocked &&
    Boolean(draft) &&
    validation.valid &&
    (editorMode === 'create' || isDirty);
  const isScheduledStart = Boolean(draft?.startsAtLocal.trim());
  const finalPrimaryLabel = firstConfigIssue
    ? 'Проверить'
    : publicationTextReady
      ? 'Опубликовать'
      : 'Заполнить публикацию';
  const finalPrimaryBusyLabel = firstConfigIssue
    ? 'Готовим…'
    : publicationTextReady
      ? 'Публикуем…'
      : 'Сохраняем…';
  const nextStepLabel =
    editorStep === 'basics'
      ? 'К условиям'
      : editorStep === 'conditions'
        ? 'К призам'
        : finalPrimaryLabel;
  const stickyTitle =
    editorStep === 'prizes'
      ? firstConfigIssue
        ? 'Нужно закончить'
        : publicationTextReady
          ? 'Готово к запуску'
          : 'Последний шаг: публикация'
      : `Шаг ${activeEditorStepIndex + 1}. ${activeEditorStep.title}`;
  const stickyDescription =
    editorStep === 'prizes'
      ? firstConfigIssue
        ? firstConfigIssue.message
        : publicationTextReady
          ? 'Черновик сохраним автоматически перед публикацией.'
          : 'Добавьте текст публикации и при необходимости фото прямо здесь.'
      : currentStepValidation.valid
        ? editorStep === 'basics'
          ? 'Дальше соберём условия участия и список каналов для проверки.'
          : 'Останется добавить места, призы и проверить публикацию.'
        : currentStepValidation.message;
  const showStickyCopy =
    !currentStepValidation.valid || (editorStep === 'prizes' && !publicationTextReady);
  const canOpenOwnedChannelsModal =
    !channelsQuery.isLoading && !channelsQuery.error && ownedSelectableChannels.length > 0;
  const requiredChannelLimitReached =
    (draft?.requiredChannelIds.length ?? 0) >= MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS;
  const handleStepPillClick = (stepId: GiveawayEditorStepId, stepIndex: number) => {
    if (stepIndex === activeEditorStepIndex) {
      return;
    }

    if (stepIndex > activeEditorStepIndex && !currentStepValidation.valid) {
      setValidationHint(currentStepValidation.message);
      pushToast({
        tone: 'danger',
        title: 'Проверьте шаг',
        description: currentStepValidation.message,
      });
      return;
    }

    setValidationHint('');
    setEditorStep(stepId);
  };

  const focusEditorTarget = (target: GiveawayValidationFocusTarget) => {
    if (target === 'channels') {
      setEditorStep('conditions');
    } else if (target === 'prizes') {
      setEditorStep('prizes');
    } else {
      setEditorStep('basics');
    }

    if (typeof window === 'undefined') {
      return;
    }

    window.setTimeout(() => {
      const element =
        target === 'title'
          ? titleInputRef.current
          : target === 'endsAt'
            ? endDateInputRef.current
            : target === 'channels'
              ? channelLinkInputRef.current
              : firstPrizeInputRef.current;

      element?.focus({ preventScroll: true });
      element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 80);
  };

  const showEditorIssue = (
    issue: { step: GiveawayEditorStepId; message: string },
    toastTitle: string,
  ) => {
    setValidationHint(issue.message);
    focusEditorTarget(resolveValidationFocusTarget(issue));
    pushToast({
      tone: 'danger',
      title: toastTitle,
      description: issue.message,
    });
  };

  const renderDashboardSurface = () => {
    if (listQuery.isLoading) {
      return (
        <div className="managed-giveaway__surface managed-giveaway__surface--dashboard">
          <div className="managed-giveaway__hero-head">
            <div className="managed-giveaway__hero-copy">
              <span className="managed-giveaway__eyebrow">Розыгрыши</span>
              <h2>Загружаем розыгрыши</h2>
              <p>Проверяем активный розыгрыш.</p>
            </div>
            <div className="managed-giveaway__hero-badges">
              <span className="managed-giveaway__badge is-muted">Загрузка</span>
            </div>
          </div>
        </div>
      );
    }

    if (!featuredItem && listQuery.error) return null;

    if (featuredItem) {
      const currentIsDraft = featuredItem.status === 'DRAFT';
      const dashboardDetails = featuredDetailsQuery.data ?? null;
      const featuredPrizes = dashboardDetails?.prizes ?? [];
      const featuredPrizeGroups = buildDashboardPrizeGroups(featuredPrizes);
      const displayPrizeTitleByPosition = new Map<number, string>();
      const repeatedFeaturedPrizeTitle = resolveRepeatedPrizeTitle(
        [...featuredPrizes]
          .sort((left, right) => left.position - right.position)
          .map((prize) => prize.displayTitle || prize.title),
      );
      for (const prize of featuredPrizes) {
        displayPrizeTitleByPosition.set(
          prize.position,
          repeatedFeaturedPrizeTitle ?? prize.displayTitle ?? prize.title,
        );
      }
      const featuredWinners =
        dashboardDetails?.winners.filter((winner) => winner.status !== 'REROLLED') ?? [];
      const requiredChannelsCount = dashboardDetails?.requiredChannelIds.length ?? 0;
      const canStartNewScenario = !currentItem && !currentIsDraft;
      const canCloseFeatured =
        featuredItem.status === 'ACTIVE' || featuredItem.status === 'SCHEDULED';
      const canDeleteFeatured =
        featuredItem.status === 'COMPLETED' || featuredItem.status === 'CANCELED';
      const dashboardEyebrow = currentIsDraft
        ? 'Текущий черновик'
        : currentItem
          ? 'Текущий розыгрыш'
          : featuredItem.status === 'COMPLETED'
            ? 'Последний завершённый'
            : 'Последний розыгрыш';

      return (
        <div className="managed-giveaway__surface managed-giveaway__surface--dashboard">
          <div className="managed-giveaway__hero-head">
            <div className="managed-giveaway__hero-copy">
              <span className="managed-giveaway__eyebrow">{dashboardEyebrow}</span>
              <h2>{featuredItem.title}</h2>
              <p>{buildCurrentSubtitle(featuredItem)}</p>
            </div>
            <div className="managed-giveaway__hero-badges">
              <span className={cn('managed-giveaway__badge', buildStatusTone(featuredItem.status))}>
                {buildStatusLabel(featuredItem.status)}
              </span>
              {featuredItem.hasImage ? (
                <span className="managed-giveaway__badge is-muted">С фото</span>
              ) : null}
              {featuredDetailsQuery.isLoading ? (
                <span className="managed-giveaway__badge is-muted">Обновляем</span>
              ) : null}
            </div>
          </div>

          <div className="managed-giveaway__dashboard-stat-grid">
            <div className="managed-giveaway__dashboard-stat">
              <span>Заявки</span>
              <strong>{featuredItem.entriesCount}</strong>
              <small>{featuredItem.verifiedEntriesCount} подтверждено</small>
            </div>
            <div className="managed-giveaway__dashboard-stat">
              <span>Условия</span>
              <strong>{1 + requiredChannelsCount}</strong>
              <small>
                {requiredChannelsCount > 0
                  ? 'доп. каналы включены'
                  : entityType === 'channel'
                    ? 'только канал розыгрыша'
                    : 'только чат розыгрыша'}
              </small>
            </div>
            <div className="managed-giveaway__dashboard-stat">
              <span>Места</span>
              <strong>{featuredPrizes.length || featuredItem.winnersCount || '—'}</strong>
              <small>
                {featuredWinners.length > 0
                  ? `${featuredWinners.length} победителей уже выбрано`
                  : currentIsDraft
                    ? 'список призов готовится'
                    : 'итоги появятся после закрытия'}
              </small>
            </div>
            <div className="managed-giveaway__dashboard-stat">
              <span>{featuredItem.status === 'COMPLETED' ? 'Итоги' : 'Завершение'}</span>
              <strong>
                {formatCompactMetricDate(
                  featuredItem.completedAt ?? featuredItem.endsAt,
                  'Без даты',
                )}
              </strong>
              <small>
                {featuredItem.status === 'SCHEDULED'
                  ? `Начало ${formatCompactMetricDate(featuredItem.startsAt, 'сразу')}`
                  : featuredItem.status === 'CANCELED'
                    ? 'розыгрыш остановлен'
                    : currentIsDraft
                      ? 'можно донастроить и опубликовать'
                      : 'актуальные сроки розыгрыша'}
              </small>
            </div>
          </div>

          {dashboardDetails?.description.trim() ? (
            <div className="managed-giveaway__dashboard-note">
              <strong>Публикация</strong>
              <p>{dashboardDetails.description.trim()}</p>
            </div>
          ) : null}

          {featuredPrizeGroups.length > 0 ? (
            <div className="managed-giveaway__dashboard-prize-rail">
              {featuredPrizeGroups.map((prize) => (
                <div
                  key={`featured-prize-${prize.id}`}
                  className={cn(
                    'managed-giveaway__dashboard-prize-chip',
                    prize.count > 1 && 'is-repeat',
                  )}
                >
                  <span>{prize.label}</span>
                  <strong>{prize.title}</strong>
                  {prize.count > 1 ? <em>×{prize.count}</em> : null}
                </div>
              ))}
            </div>
          ) : null}

          {featuredItem.publicationUrl ||
          featuredItem.resultsUrl ||
          featuredItem.status === 'COMPLETED' ? (
            <div className="managed-giveaway__dashboard-links">
              {featuredItem.publicationUrl ? (
                <button
                  type="button"
                  className="button button--ghost managed-giveaway__dashboard-link"
                  onClick={() => openManagedGiveawayLink(featuredItem.publicationUrl)}
                  disabled={isBusy}
                >
                  Открыть пост
                </button>
              ) : null}
              {featuredItem.publicationUrl && canShareNativeContent() ? (
                <button
                  type="button"
                  className="button button--ghost managed-giveaway__dashboard-link"
                  onClick={() =>
                    void shareManagedGiveawayLink(featuredItem.publicationUrl, featuredItem.title)
                  }
                  disabled={isBusy}
                >
                  Поделиться
                </button>
              ) : null}
              {featuredItem.status === 'COMPLETED' ? (
                <button
                  type="button"
                  className="button button--ghost managed-giveaway__dashboard-link"
                  disabled={isBusy}
                  onClick={() => refreshPublicationMutation.mutate(featuredItem.id)}
                >
                  {refreshPublicationMutation.isPending ? 'Обновляем…' : 'Обновить итоги в MAX'}
                </button>
              ) : null}
              {featuredItem.resultsUrl ? (
                <button
                  type="button"
                  className="button button--ghost managed-giveaway__dashboard-link"
                  onClick={() => openManagedGiveawayLink(featuredItem.resultsUrl)}
                  disabled={isBusy}
                >
                  Открыть итоги
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="managed-giveaway__primary-actions managed-giveaway__primary-actions--dashboard">
            {currentIsDraft ? (
              <button
                type="button"
                className="button button--accent"
                disabled={isBusy}
                onClick={startEditCurrentDraft}
              >
                Продолжить настройку
              </button>
            ) : null}
            {canCloseFeatured ? (
              <button
                type="button"
                className="button button--accent"
                disabled={isBusy}
                onClick={requestCloseFeaturedGiveaway}
              >
                {closeMutation.isPending ? 'Завершаем…' : 'Завершить сейчас'}
              </button>
            ) : null}
            {canStartNewScenario ? (
              <button
                type="button"
                className="button button--accent"
                disabled={isBusy}
                onClick={startCreate}
              >
                Новый розыгрыш
              </button>
            ) : null}
            {canDeleteFeatured ? (
              <button
                type="button"
                className="button button--ghost managed-giveaway__dashboard-link managed-giveaway__dashboard-link--danger"
                disabled={isBusy}
                onClick={requestDeleteFeaturedGiveaway}
              >
                {deleteMutation.isPending ? 'Архивируем…' : 'В архив'}
              </button>
            ) : null}
          </div>

          {featuredWinners.length > 0 ? (
            <div className="managed-giveaway__section managed-giveaway__section--dashboard">
              <div className="managed-giveaway__title-row">
                <div className="managed-giveaway__section-copy">
                  <strong>Победители</strong>
                </div>
                <div className="managed-giveaway__section-actions">
                  <span className="managed-giveaway__chip">{featuredWinners.length} мест</span>
                </div>
              </div>

              <div className="managed-giveaway__dashboard-winner-list">
                {featuredWinners.map((winner) => {
                  const canReroll =
                    winner.status === 'SELECTED' ||
                    winner.status === 'CLAIMED' ||
                    winner.status === 'EXPIRED';
                  const canDeliver = winner.status === 'SELECTED' || winner.status === 'CLAIMED';

                  return (
                    <div key={winner.id} className="managed-giveaway__dashboard-winner">
                      <div className="managed-giveaway__dashboard-winner-rank">
                        {winner.prizePosition}
                      </div>
                      <div className="managed-giveaway__dashboard-winner-copy">
                        <strong>{winner.displayName?.trim() || 'Победитель определён'}</strong>
                        <span>
                          {displayPrizeTitleByPosition.get(winner.prizePosition) ??
                            winner.prizeDisplayTitle ??
                            winner.prizeTitle}
                        </span>
                      </div>
                      <div className="managed-giveaway__dashboard-winner-side">
                        <span
                          className={cn(
                            'managed-giveaway__badge',
                            winner.status === 'DELIVERED'
                              ? 'is-success'
                              : winner.status === 'EXPIRED'
                                ? 'is-danger'
                                : 'is-warning',
                          )}
                        >
                          {buildWinnerStatusLabel(winner.status)}
                        </span>
                        {canDeliver || canReroll ? (
                          <div className="managed-giveaway__dashboard-winner-actions">
                            {canDeliver ? (
                              <button
                                type="button"
                                className="button button--ghost managed-giveaway__dashboard-link"
                                disabled={isBusy}
                                onClick={() => requestMarkFeaturedWinnerDelivered(winner)}
                              >
                                {deliverMutation.isPending ? 'Сохраняем…' : 'Выдано'}
                              </button>
                            ) : null}
                            {canReroll ? (
                              <button
                                type="button"
                                className="button button--ghost managed-giveaway__dashboard-link"
                                disabled={isBusy}
                                onClick={() => requestRerollFeaturedWinner(winner)}
                              >
                                {rerollMutation.isPending ? 'Выбираем…' : 'Выбрать другого'}
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {featuredDetailsQuery.error ? (
            <div className="managed-giveaway__error-inline">
              {formatApiError(
                featuredDetailsQuery.error,
                'Не удалось подгрузить детали розыгрыша.',
              )}
            </div>
          ) : null}
        </div>
      );
    }

    return (
      <div className="managed-giveaway__surface managed-giveaway__surface--dashboard">
        <div className="managed-giveaway__hero-head">
          <div className="managed-giveaway__hero-copy">
            <span className="managed-giveaway__eyebrow">Розыгрыши</span>
            <h2>Создайте розыгрыш</h2>
            <p>Настройте сроки, условия и призы.</p>
          </div>
          <div className="managed-giveaway__hero-badges">
            <GiveawayHintAnchor
              hintKey="dashboard"
              openHintKey={openHintKey}
              onToggleHint={toggleHint}
              label="Как устроен запуск розыгрыша"
            >
              Розыгрыш можно запустить сразу или запланировать на нужную дату.
            </GiveawayHintAnchor>
          </div>
        </div>

        <div className="managed-giveaway__primary-actions">
          <button
            type="button"
            className="button button--accent"
            disabled={isBusy}
            onClick={startCreate}
          >
            Новый розыгрыш
          </button>
        </div>
      </div>
    );
  };

  const renderEditorSurface = () => {
    if (!draft) {
      if (draftDetailsQuery.error) {
        return (
          <div className="managed-giveaway__error-inline" role="alert">
            {formatApiError(draftDetailsQuery.error, 'Не удалось загрузить черновик.')}
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void draftDetailsQuery.refetch()}
            >
              Повторить
            </button>
          </div>
        );
      }
      return (
        <div className="managed-giveaway__surface managed-giveaway__surface--editor">
          <div className="managed-giveaway__hero-head">
            <div className="managed-giveaway__hero-copy">
              <span className="managed-giveaway__eyebrow">Черновик</span>
              <h2>Открываем розыгрыш</h2>
              <p>Обновляем данные розыгрыша.</p>
            </div>
            <div className="managed-giveaway__hero-badges">
              <span className="managed-giveaway__badge is-muted">
                {draftDetailsQuery.isLoading ? 'Загрузка' : 'Черновик'}
              </span>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="managed-giveaway__surface managed-giveaway__surface--editor">
        <div className="managed-giveaway__hero-head">
          <div className="managed-giveaway__hero-copy managed-giveaway__hero-copy--editor">
            <span className="managed-giveaway__eyebrow">
              Шаг {activeEditorStepIndex + 1} из {editorSteps.length}
            </span>
            <div className="managed-giveaway__hero-title-row">
              <h2 ref={editorHeadingRef} tabIndex={-1}>
                {activeEditorStep.title}
              </h2>
              <button
                type="button"
                className="button button--ghost managed-giveaway__hero-button managed-giveaway__hero-button--danger"
                onClick={requestCancelEditorDraft}
                disabled={isBusy}
                aria-label={editorMode === 'create' ? 'Сбросить черновик' : 'Отменить черновик'}
                title={editorMode === 'create' ? 'Сбросить черновик' : 'Отменить черновик'}
              >
                <IconoirSprite variant="iconoir" icon="Trash" aria-hidden />
              </button>
            </div>
          </div>
          {(isDirty && editorMode === 'edit') || canSaveEditor ? (
            <div className="managed-giveaway__hero-badges">
              {isDirty && editorMode === 'edit' ? (
                <span className="managed-giveaway__badge is-warning">Не сохранено</span>
              ) : null}
              {canSaveEditor ? (
                <button
                  type="button"
                  className="button button--ghost managed-giveaway__hero-button"
                  onClick={() => {
                    void saveEditor();
                  }}
                  disabled={isBusy}
                >
                  {createMutation.isPending || updateMutation.isPending
                    ? 'Сохраняем…'
                    : 'Сохранить'}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="managed-giveaway__step-strip" aria-label="Прогресс по шагам">
          {editorSteps.map((step, index) => (
            <button
              key={step.id}
              type="button"
              className={cn(
                'managed-giveaway__step-pill',
                index === activeEditorStepIndex && 'is-active',
                step.isComplete && 'is-complete',
              )}
              onClick={() => handleStepPillClick(step.id, index)}
              aria-current={index === activeEditorStepIndex ? 'step' : undefined}
              disabled={isBusy}
            >
              <span className="managed-giveaway__step-pill-index">
                {step.isComplete && index < activeEditorStepIndex ? '✓' : index + 1}
              </span>
              <strong>{step.label}</strong>
            </button>
          ))}
        </div>

        {editorStep === 'basics' ? (
          <div className="managed-giveaway__step-stage">
            <div className="managed-giveaway__section">
              <label className="field managed-giveaway__counted-field">
                <span className="managed-giveaway__counted-label">
                  <span>Название</span>
                  <small>
                    {draft.title.length}/{MANAGED_GIVEAWAY_TITLE_MAX_LENGTH}
                  </small>
                </span>
                <input
                  ref={titleInputRef}
                  type="text"
                  value={draft.title}
                  onChange={(event) =>
                    updateDraft((current) => ({
                      ...current,
                      title: event.target.value,
                    }))
                  }
                  maxLength={MANAGED_GIVEAWAY_TITLE_MAX_LENGTH}
                  aria-invalid={!basicsValidation.valid && !draft.title.trim()}
                  aria-describedby={validationHint ? 'managed-giveaway-editor-alert' : undefined}
                  placeholder="Например: Розыгрыш на выходные"
                  disabled={isBusy}
                />
              </label>
            </div>

            <div className="managed-giveaway__section">
              <div className="managed-giveaway__title-row">
                <div className="managed-giveaway__section-copy">
                  <strong>Когда проходит</strong>
                </div>
              </div>

              <div className="managed-giveaway__subsection">
                <div className="managed-giveaway__subsection-row">
                  <div className="managed-giveaway__subsection-copy">
                    <strong>Начало</strong>
                  </div>
                </div>

                <div
                  className="managed-giveaway__choice-grid"
                  role="group"
                  aria-label="Режим начала"
                >
                  <button
                    type="button"
                    className={cn(
                      'managed-giveaway__choice-card',
                      !isScheduledStart && 'is-active',
                    )}
                    aria-pressed={!isScheduledStart}
                    disabled={isBusy}
                    onClick={() => toggleStartMode('instant')}
                  >
                    <span className="managed-giveaway__choice-copy">
                      <strong>Сразу</strong>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={cn('managed-giveaway__choice-card', isScheduledStart && 'is-active')}
                    aria-pressed={isScheduledStart}
                    disabled={isBusy}
                    onClick={() => toggleStartMode('scheduled')}
                  >
                    <span className="managed-giveaway__choice-copy">
                      <strong>По времени</strong>
                    </span>
                  </button>
                </div>

                {isScheduledStart ? (
                  <div className="managed-giveaway__split-fields">
                    <DateField
                      label="Дата начала"
                      value={readDateInputPart(draft.startsAtLocal)}
                      onChange={updateStartDate}
                      disabled={isBusy}
                    />
                    <div className="field">
                      <TimeField
                        label="Время"
                        value={readTimeInputPart(draft.startsAtLocal, '12:00')}
                        variant="embedded"
                        onChange={updateStartTime}
                        disabled={isBusy}
                      />
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="managed-giveaway__subsection">
                <div className="managed-giveaway__subsection-row">
                  <div className="managed-giveaway__subsection-copy">
                    <strong>Завершение</strong>
                  </div>
                </div>

                <div className="managed-giveaway__quick-actions">
                  {FINISH_PRESETS.map((preset) => (
                    <button
                      key={`finish-preset-${preset.hours}`}
                      type="button"
                      className="managed-giveaway__chip-button"
                      disabled={isBusy}
                      onClick={() => applyFinishPreset(preset.hours)}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>

                <div className="managed-giveaway__split-fields">
                  <DateField
                    ref={endDateInputRef}
                    label="Дата завершения"
                    value={readDateInputPart(draft.endsAtLocal)}
                    onChange={updateEndDate}
                    error={finishAtValidationError || undefined}
                    disabled={isBusy}
                  />
                  <div className="field">
                    <TimeField
                      label="Время"
                      value={readTimeInputPart(draft.endsAtLocal, '21:00')}
                      variant="embedded"
                      onChange={updateEndTime}
                      disabled={isBusy}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {editorStep === 'conditions' ? (
          <div className="managed-giveaway__step-stage">
            <div className="managed-giveaway__section managed-giveaway__section--conditions">
              <div className="managed-giveaway__title-row">
                <div className="managed-giveaway__section-copy">
                  <strong>Кто участвует</strong>
                </div>
                <div className="managed-giveaway__section-actions">
                  <span className="managed-giveaway__badge is-muted">
                    Доп. каналы {draft.requiredChannelIds.length}/
                    {MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS}
                  </span>
                  <GiveawayHintAnchor
                    hintKey="conditions"
                    openHintKey={openHintKey}
                    onToggleHint={toggleHint}
                    label="Подсказка по условиям участия"
                  >
                    {`${entityType === 'channel' ? 'Подписка на канал розыгрыша обязательна.' : 'Участие в чате розыгрыша обязательно.'} Добавьте дополнительные каналы, на которые тоже нужно подписаться.`}
                  </GiveawayHintAnchor>
                </div>
              </div>

              {selectedRequiredChannels.length > 0 ? (
                <div className="managed-giveaway__channel-list">
                  {selectedRequiredChannels.map((item, index) => (
                    <div
                      key={`required-channel-${item.id}`}
                      className="managed-giveaway__channel-row"
                    >
                      <span className="managed-giveaway__channel-index">{index + 1}</span>
                      <div className="managed-giveaway__channel-copy">
                        <strong>{item.title}</strong>
                        {item.link ? <small>{item.link}</small> : null}
                      </div>
                      <button
                        type="button"
                        className="managed-giveaway__channel-remove"
                        onClick={() => removeRequiredChannelById(item.id)}
                        disabled={isBusy}
                        aria-label={`Удалить доп. канал ${index + 1}`}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="managed-giveaway__empty managed-giveaway__empty--soft">
                  <strong>
                    {entityType === 'channel' ? 'Только канал розыгрыша' : 'Только чат розыгрыша'}
                  </strong>
                  {channelsQuery.isLoading ? <span>Загружаем ваши каналы…</span> : null}
                  {!channelsQuery.isLoading && canOpenOwnedChannelsModal ? (
                    <button
                      type="button"
                      className="button button--ghost managed-giveaway__empty-action"
                      onClick={openOwnedChannelsModal}
                      disabled={isBusy}
                    >
                      Добавить свой канал
                    </button>
                  ) : null}
                  {!channelsQuery.isLoading &&
                  !channelsQuery.error &&
                  ownedSelectableChannels.length === 0 ? (
                    <span>Нет доступных каналов, где бот уже администратор.</span>
                  ) : null}
                </div>
              )}

              <div className="managed-giveaway__subsection">
                <div className="managed-giveaway__subsection-row">
                  <div className="managed-giveaway__subsection-copy">
                    <strong>Свой канал</strong>
                  </div>
                  <div className="managed-giveaway__section-actions">
                    <GiveawayHintAnchor
                      hintKey="conditionsOwned"
                      openHintKey={openHintKey}
                      onToggleHint={toggleHint}
                      label="Подсказка по выбору своего канала"
                    >
                      Здесь показываются ваши каналы, где бот уже подключён и у вас есть доступ на
                      управление.
                    </GiveawayHintAnchor>
                    <button
                      type="button"
                      className="button button--ghost managed-giveaway__channel-action"
                      disabled={isBusy || !canOpenOwnedChannelsModal}
                      onClick={openOwnedChannelsModal}
                    >
                      {selectedOwnedChannelIds.length > 0
                        ? `Выбрано · ${selectedOwnedChannelIds.length}`
                        : 'Открыть список'}
                    </button>
                  </div>
                </div>
              </div>

              <div className="managed-giveaway__subsection">
                <div className="managed-giveaway__subsection-row">
                  <div className="managed-giveaway__subsection-copy">
                    <strong>Чужой канал</strong>
                  </div>
                  <div className="managed-giveaway__section-actions">
                    <GiveawayHintAnchor
                      hintKey="conditionsLink"
                      openHintKey={openHintKey}
                      onToggleHint={toggleHint}
                      label="Подсказка по добавлению канала по ссылке"
                    >
                      Вставьте публичную ссылку MAX. Мы проверим её и добавим канал без ручного
                      поиска по списку.
                    </GiveawayHintAnchor>
                  </div>
                </div>
                <div className="managed-giveaway__editor-grid managed-giveaway__editor-grid--align-end">
                  <label className="field">
                    <span>Публичная ссылка</span>
                    <input
                      ref={channelLinkInputRef}
                      type="text"
                      value={channelLinkValue}
                      onChange={(event) => {
                        setChannelLinkValue(event.target.value);
                        setValidationHint('');
                        setEditorError('');
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') {
                          return;
                        }

                        event.preventDefault();
                        void addRequiredChannelByLink();
                      }}
                      inputMode="url"
                      autoCapitalize="none"
                      autoCorrect="off"
                      enterKeyHint="done"
                      placeholder="https://max.ru/..."
                      aria-invalid={!conditionsValidation.valid}
                      aria-describedby={
                        validationHint ? 'managed-giveaway-editor-alert' : undefined
                      }
                      disabled={isBusy || requiredChannelLimitReached}
                    />
                  </label>
                  <div className="managed-giveaway__section-actions managed-giveaway__section-actions--align-end">
                    <button
                      type="button"
                      className="button button--ghost managed-giveaway__channel-action"
                      disabled={isBusy || requiredChannelLimitReached}
                      onClick={() => {
                        void addRequiredChannelByLink();
                      }}
                    >
                      Проверить и добавить
                    </button>
                  </div>
                </div>
              </div>

              {channelsQuery.error ? (
                <div className="managed-giveaway__error-inline">
                  {formatApiError(channelsQuery.error, 'Не удалось загрузить список каналов.')}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {editorStep === 'prizes' ? (
          <div className="managed-giveaway__step-stage">
            <div className="managed-giveaway__section">
              <div className="managed-giveaway__title-row">
                <div className="managed-giveaway__section-copy">
                  <strong>Что получают победители</strong>
                </div>
                <div className="managed-giveaway__section-actions">
                  <span className="managed-giveaway__chip">
                    {draft.prizes.length} {draft.prizes.length === 1 ? 'место' : 'мест'}
                  </span>
                  <GiveawayHintAnchor
                    hintKey="prizes"
                    openHintKey={openHintKey}
                    onToggleHint={toggleHint}
                    label="Подсказка по настройке призов"
                  >
                    Один приз на одну строку. Так карточка, результаты и публикация остаются
                    компактными и читаемыми.
                  </GiveawayHintAnchor>
                </div>
              </div>

              <div className="managed-giveaway__prize-mode" role="group" aria-label="Тип призов">
                <button
                  type="button"
                  className={cn(
                    'managed-giveaway__choice-card',
                    draft.prizeMode === 'same' && 'is-active',
                  )}
                  aria-pressed={draft.prizeMode === 'same'}
                  disabled={isBusy}
                  onClick={() => setPrizeMode('same')}
                >
                  <span className="managed-giveaway__choice-copy">
                    <strong>Одинаковые</strong>
                  </span>
                </button>
                <button
                  type="button"
                  className={cn(
                    'managed-giveaway__choice-card',
                    draft.prizeMode === 'different' && 'is-active',
                  )}
                  aria-pressed={draft.prizeMode === 'different'}
                  disabled={isBusy}
                  onClick={() => setPrizeMode('different')}
                >
                  <span className="managed-giveaway__choice-copy">
                    <strong>Разные</strong>
                  </span>
                </button>
              </div>

              <div className="managed-giveaway__prize-count-panel">
                <div className="managed-giveaway__count-stepper">
                  <button
                    type="button"
                    className="managed-giveaway__count-stepper-button"
                    disabled={isBusy || draft.prizes.length <= 1}
                    onClick={() => setPrizeCount(draft.prizes.length - 1)}
                    aria-label="Уменьшить количество мест"
                  >
                    −
                  </button>
                  <div className="managed-giveaway__count-stepper-value">
                    <span>Места</span>
                    <strong>{draft.prizes.length}</strong>
                  </div>
                  <button
                    type="button"
                    className="managed-giveaway__count-stepper-button"
                    disabled={isBusy || draft.prizes.length >= MANAGED_GIVEAWAY_MAX_PRIZES}
                    onClick={() => setPrizeCount(draft.prizes.length + 1)}
                    aria-label="Увеличить количество мест"
                  >
                    +
                  </button>
                </div>

                <div
                  className="managed-giveaway__prize-presets"
                  aria-label="Быстрое количество мест"
                >
                  {[3, 5, 10].map((count) => (
                    <button
                      key={`giveaway-prize-count-${count}`}
                      type="button"
                      className={cn(
                        'managed-giveaway__chip-button',
                        draft.prizes.length === count && 'is-active',
                      )}
                      onClick={() => setPrizeCount(count)}
                      disabled={isBusy}
                    >
                      {count}
                    </button>
                  ))}
                </div>
              </div>

              {draft.prizeMode === 'same' ? (
                <div className="managed-giveaway__same-prize-card">
                  <label className="field">
                    <span>Приз</span>
                    <input
                      ref={firstPrizeInputRef}
                      type="text"
                      value={draft.samePrizeTitle}
                      placeholder="Подарок"
                      maxLength={MANAGED_GIVEAWAY_PRIZE_TITLE_MAX_LENGTH}
                      aria-label="Одинаковый приз для всех мест"
                      aria-invalid={!prizesValidation.valid}
                      aria-describedby={
                        validationHint ? 'managed-giveaway-editor-alert' : undefined
                      }
                      onChange={(event) =>
                        updateDraft((current) => ({
                          ...current,
                          samePrizeTitle: event.target.value,
                          prizes: buildPrizeRowsFromSameTitle(
                            event.target.value,
                            current.prizes.length,
                          ),
                        }))
                      }
                      disabled={isBusy}
                    />
                  </label>
                  <div className="managed-giveaway__same-prize-preview">
                    <strong>{draft.samePrizeTitle.trim() || 'Приз'}</strong>
                    <span>×{draft.prizes.length}</span>
                  </div>
                </div>
              ) : (
                <div className="managed-giveaway__prize-editor-list">
                  {draft.prizes.map((prizeTitle, index) => (
                    <div
                      key={`draft-prize-${index}`}
                      className="managed-giveaway__prize-editor-row"
                    >
                      <span className="managed-giveaway__prize-position">{index + 1}</span>
                      <label className="field">
                        <input
                          ref={index === 0 ? firstPrizeInputRef : undefined}
                          type="text"
                          value={prizeTitle}
                          placeholder="Приз"
                          maxLength={MANAGED_GIVEAWAY_PRIZE_TITLE_MAX_LENGTH}
                          aria-label={`Приз за ${index + 1} место`}
                          aria-invalid={!prizesValidation.valid}
                          aria-describedby={
                            validationHint ? 'managed-giveaway-editor-alert' : undefined
                          }
                          onChange={(event) =>
                            updateDraft((current) => {
                              const nextPrizes = [...current.prizes];
                              nextPrizes[index] = event.target.value;
                              return {
                                ...current,
                                prizes: nextPrizes,
                              };
                            })
                          }
                          disabled={isBusy}
                        />
                      </label>
                      {draft.prizes.length > 1 ? (
                        <button
                          type="button"
                          className="managed-giveaway__prize-remove"
                          onClick={() =>
                            updateDraft((current) => ({
                              ...current,
                              prizes: current.prizes.filter(
                                (_, prizeIndex) => prizeIndex !== index,
                              ),
                            }))
                          }
                          disabled={isBusy}
                          aria-label={`Удалить приз ${index + 1}`}
                        >
                          ×
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}

              <div className="managed-giveaway__subsection">
                <div className="managed-giveaway__subsection-row">
                  <div className="managed-giveaway__subsection-copy">
                    <strong>Публикация</strong>
                  </div>
                  <div className="managed-giveaway__section-actions">
                    <span className="managed-giveaway__chip">
                      {draft.description.trim()
                        ? `${draft.description.trim().length}/2000`
                        : 'Текст'}
                    </span>
                  </div>
                </div>

                <label className="field">
                  <span>Текст публикации</span>
                  <textarea
                    rows={5}
                    value={draft.description}
                    onChange={(event) =>
                      updateDraft((current) => ({
                        ...current,
                        description: event.target.value,
                      }))
                    }
                    maxLength={2_000}
                    placeholder="Опишите розыгрыш, условия и что получат победители."
                    disabled={isBusy}
                  />
                </label>

                <div className="managed-giveaway__editor-grid managed-giveaway__editor-grid--align-end">
                  <div className="field managed-giveaway__file-field">
                    <span>Фото публикации</span>
                    <button
                      type="button"
                      className="button button--ghost managed-giveaway__file-picker"
                      disabled={isBusy}
                      tabIndex={-1}
                      aria-hidden="true"
                    >
                      {draft.imageEnabled ? 'Заменить фото' : 'Добавить фото'}
                    </button>
                    <input
                      className="managed-giveaway__file-input"
                      type="file"
                      accept="image/*"
                      onChange={handlePublicationImageChange}
                      disabled={isBusy}
                      aria-label={
                        draft.imageEnabled ? 'Заменить фото публикации' : 'Добавить фото публикации'
                      }
                    />
                  </div>
                  {draft.imageEnabled || preparingPhoto || photoError ? (
                    <div className="managed-giveaway__section-actions managed-giveaway__section-actions--align-end">
                      <button
                        type="button"
                        className="button button--ghost managed-giveaway__channel-action"
                        onClick={clearPublicationImage}
                        disabled={isBusy}
                      >
                        Убрать фото
                      </button>
                    </div>
                  ) : null}
                </div>

                {preparingPhoto ? <p role="status">Готовим фото…</p> : null}
                {photoError ? <p role="alert">{photoError}</p> : null}
                {draft.imageEnabled ? (
                  giveawayImageSource(draft) ? (
                    <details className="managed-giveaway__publication-image">
                      <summary>
                        <img src={giveawayImageSource(draft)!} alt="Миниатюра фото публикации" />
                        <span>
                          <strong>{draft.imageFileName || 'Фото публикации'}</strong>
                          <small>Посмотреть целиком</small>
                        </span>
                      </summary>
                      <img
                        className="managed-giveaway__publication-image-full"
                        src={giveawayImageSource(draft)!}
                        alt="Фото публикации целиком"
                      />
                    </details>
                  ) : (
                    <div className="managed-giveaway__empty managed-giveaway__empty--soft">
                      <strong>Фото прикреплено</strong>
                      <span>{draft.imageFileName || 'Предпросмотр этого формата недоступен.'}</span>
                    </div>
                  )
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {validationHint && !(editorStep === 'basics' && finishAtValidationError) ? (
          <div
            id="managed-giveaway-editor-alert"
            className="managed-giveaway__error-inline"
            role="alert"
            aria-live="assertive"
          >
            {validationHint}
          </div>
        ) : null}
        {revisionConflict ? (
          <section className="managed-giveaway__error-inline" role="alert">
            <strong>Черновик изменился. Ваши правки остаются в редакторе.</strong>
            <button
              type="button"
              className="button button--ghost"
              disabled={draftDetailsQuery.isFetching}
              onClick={() => void draftDetailsQuery.refetch()}
            >
              Проверить сохранённую версию
            </button>
            {draftDetailsQuery.error ? (
              <p>{formatApiError(draftDetailsQuery.error, 'Не удалось загрузить черновик.')}</p>
            ) : null}
            {draftDetailsQuery.data &&
            (draftDetailsQuery.data.draftRevision !== draftRevision ||
              draftDetailsQuery.data.status !== 'DRAFT') ? (
              <div>
                <p>
                  {draftDetailsQuery.data.title} · {buildStatusLabel(draftDetailsQuery.data.status)}{' '}
                  · {formatDateTime(draftDetailsQuery.data.updatedAt)}
                </p>
                <p>{draftDetailsQuery.data.description}</p>
                <p>
                  Мест: {draftDetailsQuery.data.prizes.length} · До{' '}
                  {formatDateTime(draftDetailsQuery.data.endsAt)}
                </p>
                {draftDetailsQuery.data.status === 'DRAFT' ? (
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => applyEditorPayload(draftDetailsQuery.data!)}
                  >
                    Заменить мои правки сохранённой версией
                  </button>
                ) : (
                  <button type="button" className="button button--ghost" onClick={clearEditor}>
                    Закрыть редактор
                  </button>
                )}
              </div>
            ) : null}
          </section>
        ) : null}
        {editorError && !revisionConflict ? (
          <div className="managed-giveaway__error-inline" role="alert" aria-live="assertive">
            {editorError}
          </div>
        ) : null}

        <div
          className={cn(
            'managed-giveaway__action-dock',
            !showStickyCopy && 'managed-giveaway__action-dock--compact',
          )}
        >
          {showStickyCopy ? (
            <div className="managed-giveaway__action-dock-copy">
              <strong>{stickyTitle}</strong>
              <span>{stickyDescription}</span>
            </div>
          ) : null}
          <div className="managed-giveaway__action-dock-actions">
            {activeEditorStepIndex > 0 ? (
              <button
                type="button"
                className="button button--ghost"
                onClick={goToPreviousStep}
                disabled={isBusy}
              >
                <IconoirSprite variant="iconoir" icon="NavArrowLeft" aria-hidden />
                Назад
              </button>
            ) : null}
            <button
              type="button"
              className="button button--accent"
              onClick={() => {
                if (activeEditorStepIndex >= editorSteps.length - 1) {
                  handleFinalPrimaryAction();
                  return;
                }
                goToNextStep();
              }}
              disabled={isBusy || !draft || (editorStep === 'prizes' && draftActionBlocked)}
            >
              {isBusy
                ? activeEditorStepIndex >= editorSteps.length - 1
                  ? finalPrimaryBusyLabel
                  : 'Переходим…'
                : nextStepLabel}
              {activeEditorStepIndex < editorSteps.length - 1 ? (
                <IconoirSprite variant="iconoir" icon="NavArrowRight" aria-hidden />
              ) : null}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderOwnedChannelsModal = () => {
    if (
      typeof document === 'undefined' ||
      !channelModalOpen ||
      editorStep !== 'conditions' ||
      !draft
    ) {
      return null;
    }

    const ownedSelectionLimitRemaining = Math.max(
      0,
      MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS -
        (draft.requiredChannelIds.length - selectedOwnedChannelIds.length),
    );
    const modalSelectionLimitReached = channelModalSelection.length >= ownedSelectionLimitRemaining;

    return createPortal(
      <div className="managed-giveaway-modal" aria-hidden={!channelModalOpen}>
        <button
          type="button"
          className="managed-giveaway-modal__backdrop"
          aria-label="Закрыть выбор каналов"
          tabIndex={-1}
          onClick={() => setChannelModalOpen(false)}
        />

        <section
          ref={channelModalPanelRef}
          className="managed-giveaway-modal__panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="managed-giveaway-modal-title"
          aria-describedby="managed-giveaway-modal-description"
          tabIndex={-1}
        >
          <div className="managed-giveaway-modal__grabber" aria-hidden />

          <div className="managed-giveaway-modal__sheet">
            <div className="managed-giveaway-modal__head">
              <div>
                <strong id="managed-giveaway-modal-title">Добавьте свои каналы</strong>
                <small id="managed-giveaway-modal-description">
                  Отметьте каналы, которые станут дополнительным условием участия.
                </small>
              </div>
              <span className="managed-giveaway__badge is-muted">
                {channelModalSelection.length}/{ownedSelectionLimitRemaining}
              </span>
            </div>

            {channelsQuery.isLoading ? (
              <div className="managed-giveaway__empty managed-giveaway__empty--soft">
                <strong>Загружаем каналы</strong>
              </div>
            ) : null}

            {!channelsQuery.isLoading && channelsQuery.error ? (
              <div className="managed-giveaway__error-inline">
                {formatApiError(channelsQuery.error, 'Не удалось загрузить список каналов.')}
              </div>
            ) : null}

            {!channelsQuery.isLoading &&
            !channelsQuery.error &&
            ownedSelectableChannels.length === 0 ? (
              <div className="managed-giveaway__empty managed-giveaway__empty--soft">
                <strong>Нет доступных каналов</strong>
                <span>Бот должен быть администратором канала, чтобы включить его в проверку.</span>
              </div>
            ) : null}

            {!channelsQuery.isLoading &&
            !channelsQuery.error &&
            ownedSelectableChannels.length > 0 ? (
              <div className="managed-giveaway-modal__list" aria-label="Список своих каналов">
                {ownedSelectableChannels.map((channel) => {
                  const checked = channelModalSelection.includes(channel.id);
                  const optionDisabled = isBusy || (!checked && modalSelectionLimitReached);

                  return (
                    <label
                      key={`owned-channel-option-${channel.id}`}
                      className={cn(
                        'managed-giveaway-modal__option',
                        checked && 'is-selected',
                        optionDisabled && 'is-disabled',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setChannelModalSelection((current) =>
                            current.includes(channel.id)
                              ? current.filter((item) => item !== channel.id)
                              : current.length < ownedSelectionLimitRemaining
                                ? [...current, channel.id]
                                : current,
                          );
                        }}
                        disabled={optionDisabled}
                      />
                      <span className="managed-giveaway-modal__checkbox" aria-hidden>
                        {checked ? '✓' : ''}
                      </span>
                      <span className="managed-giveaway-modal__option-copy">
                        <strong>{channel.title}</strong>
                        {channel.link ? <small>{channel.link}</small> : null}
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : null}

            <div className="managed-giveaway-modal__actions">
              <button
                type="button"
                className="button button--ghost"
                onClick={() => setChannelModalOpen(false)}
                disabled={isBusy}
              >
                Отмена
              </button>
              <button
                type="button"
                className="button button--accent"
                onClick={applyOwnedChannelsSelection}
                disabled={isBusy}
              >
                Сохранить выбор
              </button>
            </div>
          </div>
        </section>
      </div>,
      document.body,
    );
  };

  const confirmationCopy = (() => {
    if (!pendingConfirmation) {
      return null;
    }

    switch (pendingConfirmation.kind) {
      case 'publish':
        return {
          title: 'Опубликовать розыгрыш?',
          summary: `«${draft?.title.trim()}». Начало: ${draft?.startsAtLocal ? formatDateTime(new Date(draft.startsAtLocal).toISOString()) : 'сразу'}. Завершение: ${draft?.endsAtLocal ? formatDateTime(new Date(draft.endsAtLocal).toISOString()) : 'не задано'}. Мест: ${draft?.prizes.length ?? 0}. Обязательных подписок: ${(draft?.requiredChannelIds.length ?? 0) + 1}. После публикации условия нельзя изменить.`,
          confirmLabel: 'Опубликовать',
          confirmBusyLabel: 'Публикуем…',
          cancelLabel: 'Вернуться к настройкам',
          tone: 'accent' as const,
        };
      case 'discard-editor':
        return {
          title:
            pendingConfirmation.origin === 'back' ? 'Выйти без сохранения?' : 'Сбросить изменения?',
          summary:
            pendingConfirmation.origin === 'back'
              ? 'В черновике есть несохранённые изменения. Их можно сохранить перед выходом.'
              : 'Черновик ещё не сохранён. Эти изменения будут потеряны.',
          confirmLabel: pendingConfirmation.origin === 'back' ? 'Выйти без сохранения' : 'Сбросить',
          confirmBusyLabel: 'Закрываем…',
          cancelLabel: 'Продолжить редактирование',
          tone: 'danger' as const,
        };
      case 'cancel-draft':
        return {
          title: 'Отменить черновик?',
          summary: 'Черновик останется в истории со статусом «Отменён».',
          confirmLabel: 'Отменить черновик',
          confirmBusyLabel: 'Отменяем…',
          cancelLabel: 'Продолжить редактирование',
          tone: 'danger' as const,
        };
      case 'close':
        return {
          title: 'Завершить розыгрыш?',
          summary: `«${pendingConfirmation.title}» перейдёт к подведению итогов. Отменить это действие нельзя.`,
          confirmLabel: 'Завершить',
          confirmBusyLabel: 'Завершаем…',
          cancelLabel: 'Не сейчас',
          tone: 'danger' as const,
        };
      case 'reroll':
        return {
          title: 'Выбрать другого победителя?',
          summary: `Победитель «${pendingConfirmation.winnerName}» будет заменён. Отменить это действие нельзя.`,
          confirmLabel: 'Выбрать другого',
          confirmBusyLabel: 'Выбираем…',
          cancelLabel: 'Не сейчас',
          tone: 'danger' as const,
        };
      case 'deliver':
        return {
          title: 'Отметить выдачу?',
          summary: `«${pendingConfirmation.winnerName}» будет отмечен как получивший приз.`,
          confirmLabel: 'Отметить выданным',
          confirmBusyLabel: 'Сохраняем…',
          cancelLabel: 'Не сейчас',
          tone: 'accent' as const,
        };
      case 'delete':
        return {
          title: 'Убрать розыгрыш в архив?',
          summary: `«${pendingConfirmation.title}» исчезнет из списка. Пост и итоги останутся в MAX.`,
          confirmLabel: 'В архив',
          confirmBusyLabel: 'Архивируем…',
          cancelLabel: 'Оставить в списке',
          tone: 'danger' as const,
        };
    }
  })();
  const canSaveBeforeExit =
    pendingConfirmation?.kind === 'discard-editor' &&
    Boolean(draft) &&
    validation.valid &&
    !draftActionBlocked;

  return (
    <div
      className={cn(
        'managed-giveaway',
        isEditingOpen ? 'managed-giveaway--editing' : 'managed-giveaway--dashboard',
        isEditingOpen && `managed-giveaway--step-${editorStep}`,
      )}
    >
      {!isEditingOpen && sortedItems.length > 1 ? (
        <label className="managed-giveaway__history-select">
          <span>Розыгрыш</span>
          <select
            aria-label="Выбрать розыгрыш"
            value={featuredGiveawayId ?? ''}
            disabled={isBusy}
            onChange={(event) => setSelectedGiveawayId(event.target.value)}
          >
            {sortedItems.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title} · {buildStatusLabel(item.status)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {!isEditingOpen ? renderDashboardSurface() : null}

      {isEditingOpen ? renderEditorSurface() : null}

      {listQuery.error ? (
        <div className="managed-giveaway__error-inline">
          <span>{formatApiError(listQuery.error, 'Не удалось загрузить розыгрыши.')}</span>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              void listQuery.refetch();
            }}
          >
            Повторить
          </button>
        </div>
      ) : null}

      {renderOwnedChannelsModal()}

      {pendingConfirmation && confirmationCopy ? (
        <Suspense fallback={null}>
          <LazyActionConfirmSheet
            id="managed-giveaway-confirmation"
            open
            title={confirmationCopy.title}
            summary={confirmationCopy.summary}
            tone={confirmationCopy.tone}
            confirmLabel={confirmationCopy.confirmLabel}
            confirmBusyLabel={confirmationCopy.confirmBusyLabel}
            cancelLabel={confirmationCopy.cancelLabel}
            isBusy={isBusy}
            extraActionLabel={
              pendingConfirmation.kind === 'discard-editor' ? 'Сохранить и выйти' : undefined
            }
            extraActionBusyLabel="Сохраняем…"
            extraActionBusy={createMutation.isPending || updateMutation.isPending}
            extraActionDisabled={!canSaveBeforeExit}
            onExtraAction={
              pendingConfirmation.kind === 'discard-editor'
                ? () => {
                    void saveAndCloseEditor();
                  }
                : undefined
            }
            onClose={() => setPendingConfirmation(null)}
            onConfirm={() => {
              void confirmPendingAction();
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

export const ManagedGiveawayCard = forwardRef(ManagedGiveawayCardImpl);
