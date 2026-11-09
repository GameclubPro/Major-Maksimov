import { useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useState } from 'react';
import type {
  PublicationSummary,
  PublicationDetails,
  PublicationOccurrenceSummary,
  ListPublicationDeliveriesResponse,
} from '@maxim/contracts/publication';
import type { ApiTransport } from '../../lib/api/transport';
import {
  cancelPublication,
  pausePublication,
  resumePublication,
  retryPublicationOccurrence,
  resolvePublicationAmbiguousDelivery,
} from '../../lib/api/publication-client';
import { useToast } from '../../components/ui/toast';
import { describeUserFacingError } from '../../lib/user-facing-error';
import {
  isPublicationRevisionConflictError,
  isPublicationOccurrenceContentStale,
} from './publication-model';
import { publicationQueryKeys as queryKeys } from './publication-query-keys';

type PublicationActionTarget = {
  publication: PublicationSummary;
  action: 'cancel' | 'pause' | 'resume';
};

type PublicationAmbiguousTarget = {
  publicationId: string;
  occurrenceId: string;
  deliveryId: string;
  resolution: 'mark_sent' | 'mark_failed';
};

type PublicationRetryTarget =
  | {
      publicationId: string;
      occurrenceId: string;
      contentMode: 'original';
    }
  | {
      publicationId: string;
      occurrenceId: string;
      contentMode: 'latest';
      expectedPublicationVersion: number;
      expectedContentRevision: number;
    };

type PublicationRetryChoiceTarget = {
  publicationId: string;
  occurrenceId: string;
  publicationVersion: number;
  originalContentRevision?: number;
  latestContentRevision: number;
};

// FLAG: All action slots share the page's request-identity owner; errors retain the identity.
export interface PublicationActionRequestIds {
  resolveActionRequestId(
    publicationId: string,
    action: 'cancel' | 'pause' | 'resume',
    expectedRevision: number,
  ): string;
  resolveRetryRequestId(target: PublicationRetryTarget): string;
  resolveAmbiguousRequestId(target: PublicationAmbiguousTarget): string;
  confirmActionSuccess(): void;
  confirmRetrySuccess(): void;
  confirmAmbiguousSuccess(): void;
}

export function usePublicationActions(api: ApiTransport, requestIds: PublicationActionRequestIds) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [actionTarget, setActionTarget] = useState<PublicationActionTarget | null>(null);
  const [detailsTarget, setDetailsTarget] = useState<PublicationSummary | null>(null);
  const [ambiguousTarget, setAmbiguousTarget] = useState<PublicationAmbiguousTarget | null>(null);
  const [retryChoiceTarget, setRetryChoiceTarget] = useState<PublicationRetryChoiceTarget | null>(
    null,
  );

  const actionMutation = useMutation({
    mutationFn: ({ publication, action }: PublicationActionTarget) => {
      const payload = {
        expectedRevision: publication.version,
        requestId: requestIds.resolveActionRequestId(publication.id, action, publication.version),
      };
      if (action === 'cancel') {
        return cancelPublication(api, publication.id, payload);
      }
      return action === 'pause'
        ? pausePublication(api, publication.id, payload)
        : resumePublication(api, publication.id, payload);
    },
    onSuccess: async (_, variables) => {
      requestIds.confirmActionSuccess();
      setActionTarget(null);
      setDetailsTarget(null);
      await invalidatePublicationQueries();
      pushToast({
        tone: variables.action === 'cancel' ? 'info' : 'success',
        title:
          variables.action === 'cancel'
            ? 'Публикация отменена'
            : variables.action === 'pause'
              ? 'Расписание на паузе'
              : 'Расписание запущено',
      });
    },
    onError: async (error) => {
      if (isPublicationRevisionConflictError(error)) {
        setActionTarget(null);
        await Promise.all([
          invalidatePublicationQueries(),
          queryClient.invalidateQueries({ queryKey: ['publications', 'details'] }),
        ]);
        pushToast({ tone: 'info', title: 'Публикация обновлена' });
        return;
      }
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось выполнить действие'),
      });
    },
  });
  const retryMutation = useMutation({
    mutationFn: (target: PublicationRetryTarget) =>
      retryPublicationOccurrence(api, target.publicationId, target.occurrenceId, {
        requestId: requestIds.resolveRetryRequestId(target),
        contentMode: target.contentMode,
        ...(target.contentMode === 'latest'
          ? {
              expectedPublicationVersion: target.expectedPublicationVersion,
              expectedContentRevision: target.expectedContentRevision,
            }
          : {}),
      }),
    onSuccess: async () => {
      requestIds.confirmRetrySuccess();
      setRetryChoiceTarget(null);
      await Promise.all([
        invalidatePublicationQueries(),
        queryClient.invalidateQueries({ queryKey: ['publications', 'details'] }),
        queryClient.invalidateQueries({ queryKey: ['publications', 'deliveries'] }),
      ]);
      pushToast({ tone: 'success', title: 'Повтор поставлен в очередь' });
    },
    onError: async (error) => {
      if (isPublicationRevisionConflictError(error)) {
        setRetryChoiceTarget(null);
        await Promise.all([
          invalidatePublicationQueries(),
          queryClient.invalidateQueries({ queryKey: ['publications', 'details'] }),
          queryClient.invalidateQueries({ queryKey: ['publications', 'deliveries'] }),
        ]);
        pushToast({ tone: 'info', title: 'Публикация обновлена' });
        return;
      }
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось повторить отправку'),
      });
    },
  });
  const resolveAmbiguousMutation = useMutation({
    mutationFn: (target: PublicationAmbiguousTarget) =>
      resolvePublicationAmbiguousDelivery(api, target.publicationId, target.occurrenceId, {
        requestId: requestIds.resolveAmbiguousRequestId(target),
        deliveryId: target.deliveryId,
        resolution: target.resolution,
      }),
    onSuccess: async (details, target) => {
      requestIds.confirmAmbiguousSuccess();
      setAmbiguousTarget(null);
      // FLAG: A pre-resolution read must not restore its unknown outcome after this decision.
      await Promise.all([
        queryClient.cancelQueries({
          queryKey: ['publications', 'details', target.publicationId],
        }),
        queryClient.cancelQueries({
          queryKey: ['publications', 'deliveries', target.publicationId],
        }),
      ]);
      queryClient.setQueryData(['publications', 'details', target.publicationId], details);
      queryClient.setQueriesData<InfiniteData<ListPublicationDeliveriesResponse>>(
        { queryKey: ['publications', 'deliveries', target.publicationId] },
        (cached) =>
          cached && {
            ...cached,
            pages: cached.pages.map((page) => ({
              ...page,
              items: page.items.filter((item) => item.id !== target.deliveryId),
            })),
          },
      );
      await Promise.all([
        invalidatePublicationQueries(),
        queryClient.invalidateQueries({ queryKey: ['publications', 'details'] }),
        queryClient.invalidateQueries({ queryKey: ['publications', 'deliveries'] }),
      ]);
      pushToast({ tone: 'success', title: 'Статус обновлён' });
    },
    onError: (error) =>
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось сохранить статус'),
      }),
  });

  function requestPublicationRetry(
    publication: PublicationDetails,
    occurrence: PublicationOccurrenceSummary,
  ) {
    if (isPublicationOccurrenceContentStale(occurrence, publication.content.revision)) {
      setRetryChoiceTarget({
        publicationId: publication.id,
        occurrenceId: occurrence.id,
        publicationVersion: publication.version,
        originalContentRevision: occurrence.contentRevision,
        latestContentRevision: publication.content.revision,
      });
      return;
    }
    retryMutation.mutate({
      publicationId: publication.id,
      occurrenceId: occurrence.id,
      contentMode: 'original',
    });
  }

  async function invalidatePublicationQueries() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.listRoot }),
      queryClient.invalidateQueries({ queryKey: ['publications', 'calendar'] }),
    ]);
  }
  return {
    actionTarget,
    setActionTarget,
    detailsTarget,
    setDetailsTarget,
    ambiguousTarget,
    setAmbiguousTarget,
    retryChoiceTarget,
    setRetryChoiceTarget,
    actionMutation,
    retryMutation,
    resolveAmbiguousMutation,
    requestPublicationRetry,
  };
}
