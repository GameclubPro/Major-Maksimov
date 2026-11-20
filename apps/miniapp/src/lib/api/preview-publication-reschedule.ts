import {
  publicationOccurrenceRescheduleResponseSchema,
  type CreatePublicationRequest,
  type PublicationAsset,
  type PublicationContentInput,
  type PublicationDetails,
  type PublicationOccurrenceRescheduleRequest,
  type PublicationOccurrenceRescheduleResponse,
  type PublicationScheduleInput,
} from '@maxim/contracts/publication';
import { ApiRequestError } from '../api-request-error';
import { readPreviewClock } from './preview-transport-runtime';
import { cloneJson } from './preview-transport-shared';
import type { PreviewState } from './preview-transport-state';

type PreviewRescheduleDependencies = {
  buildPreviewPublicationContentInput: (publication: PublicationDetails) => PublicationContentInput;
  buildPreviewPublicationDetails: (
    state: PreviewState,
    request: Omit<CreatePublicationRequest, 'requestId'>,
    options: { id: string; now: Date; retainedAssets: readonly PublicationAsset[] },
  ) => { publication: PublicationDetails };
  assertPreviewPublicationScheduleAvailability: (
    state: PreviewState,
    input: Pick<CreatePublicationRequest, 'audience' | 'schedule' | 'intent'>,
  ) => void;
  syncPreviewPublication: (state: PreviewState, publicationId: string) => PublicationDetails;
};

const previewRescheduleRequests = new WeakMap<
  PreviewState,
  Map<string, { fingerprint: string; response: PublicationOccurrenceRescheduleResponse }>
>();

export function reschedulePreviewPublication(
  state: PreviewState,
  source: PublicationDetails,
  occurrenceId: string,
  request: PublicationOccurrenceRescheduleRequest,
  {
    buildPreviewPublicationContentInput,
    buildPreviewPublicationDetails,
    assertPreviewPublicationScheduleAvailability,
    syncPreviewPublication,
  }: PreviewRescheduleDependencies,
): PublicationOccurrenceRescheduleResponse {
  const requests = previewRescheduleRequests.get(state) ?? new Map();
  previewRescheduleRequests.set(state, requests);
  const fingerprint = JSON.stringify({ publicationId: source.id, occurrenceId, request });
  const replay = requests.get(request.requestId);
  const reject = (status: number, code: string, message: string): never => {
    throw new ApiRequestError(status, JSON.stringify({ code, message }), message);
  };
  if (replay) {
    if (replay.fingerprint !== fingerprint)
      reject(409, 'PUBLICATION_REVISION_CONFLICT', 'Запрос уже использован.');
    return cloneJson(replay.response);
  }
  const rule = source.schedule;
  const now = readPreviewClock(state.clock);
  const selected = source.occurrences.find(({ id }) => id === occurrenceId);
  if (
    source.version !== request.expectedRevision ||
    source.lifecycle !== 'ACTIVE' ||
    rule?.mode !== 'recurrence' ||
    rule.status !== 'ACTIVE' ||
    !selected
  ) {
    return reject(409, 'PUBLICATION_REVISION_CONFLICT', 'Расписание изменилось.');
  }
  const cutoff = Date.parse(selected.scheduledAt);
  const untouched = (occurrence: typeof selected) =>
    occurrence.status === 'SCHEDULED' &&
    Date.parse(occurrence.scheduledAt) > now.getTime() &&
    !state.publicationDeliveries.some(({ occurrenceId: id }) => id === occurrence.id);
  const prefix = source.occurrences.filter((item) => Date.parse(item.scheduledAt) < cutoff);
  const tail =
    request.scope === 'occurrence'
      ? [selected]
      : source.occurrences.filter(
          (item) => Date.parse(item.scheduledAt) >= cutoff && item.status !== 'CANCELED',
        );
  if (!untouched(selected) || tail.some((item) => !untouched(item))) {
    return reject(409, 'PUBLICATION_OCCURRENCE_ALREADY_STARTED', 'Выпуск уже отправляется.');
  }
  const common = { timezone: rule.timezone, latePolicy: rule.latePolicy, replaceConflicts: false };
  const remaining =
    rule.maxOccurrences === null
      ? null
      : rule.maxOccurrences -
        prefix.filter(
          (item) => item.status !== 'CANCELED' || item.calendarConflict || item.skippedByEditor,
        ).length;
  const schedule: PublicationScheduleInput =
    request.scope === 'occurrence'
      ? { ...common, mode: 'once', at: request.at }
      : {
          ...request.schedule,
          ...common,
          maxOccurrences: remaining,
          startsAt: request.schedule.startsAt ?? selected.scheduledAt,
          endsAt:
            rule.endsAt &&
            (!request.schedule.endsAt ||
              Date.parse(rule.endsAt) < Date.parse(request.schedule.endsAt))
              ? rule.endsAt
              : request.schedule.endsAt,
        };
  if (
    schedule.mode === 'once' &&
    (Date.parse(schedule.at) <= now.getTime() || Date.parse(schedule.at) === cutoff)
  ) {
    return reject(400, 'PUBLICATION_INVALID_TIME', 'Выберите другое будущее время.');
  }
  if (schedule.mode === 'recurrence' && remaining !== null && remaining < 1) {
    return reject(400, 'PUBLICATION_INVALID_TIME', 'В серии больше нет выпусков для переноса.');
  }
  const input = {
    title: source.title,
    intent: 'publish' as const,
    audience: {
      selection: 'SELECTED' as const,
      mode: 'SNAPSHOT' as const,
      targets: source.targets.map(({ chatId, entityType }) => ({ chatId, entityType })),
    },
    content: buildPreviewPublicationContentInput(source),
    schedule,
  };
  const tailStatuses = tail.map((item) => item.status);
  for (const item of tail) item.status = 'CANCELED';
  try {
    assertPreviewPublicationScheduleAvailability(state, input);
  } catch (error) {
    tail.forEach((item, index) => {
      item.status = tailStatuses[index]!;
    });
    throw error;
  }
  const replacement = buildPreviewPublicationDetails(state, input, {
    id: `publication-preview-move-${request.requestId}`,
    now,
    retainedAssets: source.content.media,
  }).publication;
  if (request.scope === 'occurrence') selected.skippedByEditor = true;
  else if (prefix.length > 0) {
    rule.endsAt = new Date(cutoff - 1).toISOString();
    rule.revision += 1;
  } else {
    source.lifecycle = 'CANCELED';
    rule.status = 'CANCELED';
    rule.revision += 1;
  }
  source.version += 1;
  source.updatedAt = now.toISOString();
  state.publications = [replacement, ...state.publications];
  const response = publicationOccurrenceRescheduleResponseSchema.parse({
    source: syncPreviewPublication(state, source.id),
    publication: syncPreviewPublication(state, replacement.id),
  });
  requests.set(request.requestId, { fingerprint, response });
  return cloneJson(response);
}
