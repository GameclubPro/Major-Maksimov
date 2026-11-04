import {
  safetyDeskDecisionResponseSchema,
  safetyDeskDeleteRuntimeResponseSchema,
  safetyDeskDeleteEvidenceResponseSchema,
  safetyDeskQueueResponseSchema,
  safetyDeskRetentionRuntimeResponseSchema,
  safetyDeskRetentionPreviewResponseSchema,
  safetyDeskRetryRetentionRequestSchema,
  type SafetyDeskDecisionResponse,
  type SafetyDeskDeleteIntentItem,
  type SafetyDeskDeleteRuntimeResponse,
  type SafetyDeskDeleteEvidenceResponse,
  type SafetyDeskQueueResponse,
  commercialReviewQueueResponseSchema,
  commercialReviewItemSchema,
  type CommercialReviewQueueResponse,
  type CommercialReviewItem,
  type CommercialReviewLabel,
  type CommercialReviewSemanticAnnotationRequest,
  type SafetyDeskRetentionRuntimeResponse,
  type SafetyDeskRetentionPreviewResponse,
  type SafetyDeskRetryRetentionRequest,
  safetyDeskWebhookCohortResponseSchema,
  type SafetyDeskWebhookCohortResponse,
  safetyDeskPublicationCohortResponseSchema,
  type SafetyDeskPublicationCohortResponse,
  safetyDeskDeleteCohortResponseSchema,
  type SafetyDeskDeleteCohortResponse,
  safetyDeskPublicationDeliveryCohortResponseSchema,
  type SafetyDeskPublicationDeliveryCohortResponse,
  safetyDeskPublicationDeliveryEvidenceResponseSchema,
  type SafetyDeskPublicationDeliveryEvidenceResponse,
  safetyDeskCommercialAiResponseSchema,
  type SafetyDeskCommercialAiResponse,
  safetyDeskCommercialAiPoolResponseSchema,
  type SafetyDeskCommercialAiPoolResponse,
  safetyDeskOverviewResponseSchema,
  type SafetyDeskOverviewResponse,
} from '@maxim/contracts/safety-desk';
import { createAdminApiTransport, type AdminApiTransport } from './admin-request';

const SAFETY_DESK_API_BASE = '/api/v1/safety-desk';

export type SafetyDeskDecisionAction = 'approve' | 'reject' | 'recheck';

export class SafetyDeskApiClient {
  constructor(private readonly transport: AdminApiTransport = createAdminApiTransport()) {}

  fetchCommercialReview(
    cursor?: string,
    status: 'PENDING' | 'REVIEWED' | 'ALL' = 'PENDING',
  ): Promise<CommercialReviewQueueResponse> {
    const query = new URLSearchParams({ limit: '50', status, ...(cursor ? { cursor } : {}) });
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/commercial/review?${query}`,
      commercialReviewQueueResponseSchema,
    );
  }

  labelCommercialReview(
    item: CommercialReviewItem,
    label: CommercialReviewLabel,
    reason: string,
    expectedDisposition: 'KEEP' | 'DELETE' | null = label === 'COMMERCIAL'
      ? 'DELETE'
      : label === 'NOT_COMMERCIAL'
        ? 'KEEP'
        : null,
    semanticAnnotation?: CommercialReviewSemanticAnnotationRequest,
  ): Promise<CommercialReviewItem> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/commercial/review/${encodeURIComponent(item.id)}/label`,
      commercialReviewItemSchema,
      {
        method: 'POST',
        body: {
          expectedUpdatedAt: item.updatedAt,
          label,
          expectedDisposition,
          reason,
          ...(semanticAnnotation ? { semanticAnnotation } : {}),
        },
      },
    );
  }

  adjudicateCommercialReview(
    item: CommercialReviewItem,
    label: CommercialReviewLabel,
    reason: string,
    expectedDisposition: 'KEEP' | 'DELETE' | null,
    semanticAnnotation?: CommercialReviewSemanticAnnotationRequest,
  ): Promise<CommercialReviewItem> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/commercial/review/${encodeURIComponent(item.id)}/adjudicate`,
      commercialReviewItemSchema,
      {
        method: 'POST',
        body: {
          expectedUpdatedAt: item.updatedAt,
          label,
          expectedDisposition,
          reason,
          ...(semanticAnnotation ? { semanticAnnotation } : {}),
        },
      },
    );
  }

  fetchQueue(): Promise<SafetyDeskQueueResponse> {
    return this.transport.request(`${SAFETY_DESK_API_BASE}/queue`, safetyDeskQueueResponseSchema);
  }

  fetchDeleteRuntime(): Promise<SafetyDeskDeleteRuntimeResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/deletes`,
      safetyDeskDeleteRuntimeResponseSchema,
    );
  }

  fetchRuntimeOverview(signal?: AbortSignal): Promise<SafetyDeskOverviewResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/overview`,
      safetyDeskOverviewResponseSchema,
      { signal, cache: 'no-store' },
    );
  }

  fetchCommercialAiRuntime(): Promise<SafetyDeskCommercialAiResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/commercial-ai`,
      safetyDeskCommercialAiResponseSchema,
    );
  }

  fetchCommercialAiPoolRuntime(): Promise<SafetyDeskCommercialAiPoolResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/commercial-ai/pool`,
      safetyDeskCommercialAiPoolResponseSchema,
    );
  }

  async fetchDeleteEvidence(intentId: string): Promise<SafetyDeskDeleteEvidenceResponse> {
    const snapshot = await this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/deletes/${encodeURIComponent(intentId)}/evidence`,
      safetyDeskDeleteEvidenceResponseSchema,
    );
    if (snapshot.intentId !== intentId)
      throw new Error('Подтверждения относятся к другому удалению.');
    return snapshot;
  }

  fetchWebhookCohort(): Promise<SafetyDeskWebhookCohortResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/webhook-cohort`,
      safetyDeskWebhookCohortResponseSchema,
    );
  }

  fetchPublicationCohort(): Promise<SafetyDeskPublicationCohortResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/publication-cohort`,
      safetyDeskPublicationCohortResponseSchema,
    );
  }

  fetchDeleteCohort(): Promise<SafetyDeskDeleteCohortResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/delete-cohort`,
      safetyDeskDeleteCohortResponseSchema,
    );
  }

  fetchPublicationDeliveryCohort(): Promise<SafetyDeskPublicationDeliveryCohortResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/publication-delivery-cohort`,
      safetyDeskPublicationDeliveryCohortResponseSchema,
    );
  }

  async fetchPublicationDeliveryEvidence(
    deliveryId: string,
  ): Promise<SafetyDeskPublicationDeliveryEvidenceResponse> {
    const snapshot = await this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/publication-deliveries/${encodeURIComponent(deliveryId)}/evidence`,
      safetyDeskPublicationDeliveryEvidenceResponseSchema,
    );
    if (snapshot.deliveryId !== deliveryId)
      throw new Error('Подтверждения относятся к другой доставке.');
    return snapshot;
  }

  fetchRetentionRuntime(after: string | null = null): Promise<SafetyDeskRetentionRuntimeResponse> {
    const cursor = after ? `?after=${encodeURIComponent(after)}` : '';
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/retention${cursor}`,
      safetyDeskRetentionRuntimeResponseSchema,
    );
  }

  fetchRetentionPreview(
    chatId: string,
    after: string | null = null,
  ): Promise<SafetyDeskRetentionPreviewResponse> {
    const cursor = after ? `?after=${encodeURIComponent(after)}` : '';
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/retention/${encodeURIComponent(chatId)}/preview${cursor}`,
      safetyDeskRetentionPreviewResponseSchema,
    );
  }

  retryRetention(
    chatId: string,
    request: SafetyDeskRetryRetentionRequest,
  ): Promise<SafetyDeskRetentionPreviewResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/retention/${encodeURIComponent(chatId)}/retry`,
      safetyDeskRetentionPreviewResponseSchema,
      { method: 'POST', body: safetyDeskRetryRetentionRequestSchema.parse(request) },
    );
  }

  allowAmbiguousSendRetry(
    item: SafetyDeskDeleteRuntimeResponse['ambiguousSends'][number],
  ): Promise<SafetyDeskDeleteRuntimeResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/ambiguous-sends/${encodeURIComponent(item.id)}/allow-retry`,
      safetyDeskDeleteRuntimeResponseSchema,
      {
        method: 'POST',
        body: {
          expectedOperationId: item.messageId,
          expectedStartedAt: item.startedAt,
        },
      },
    );
  }

  retryDeleteIntent(
    item: Pick<SafetyDeskDeleteIntentItem, 'id' | 'status' | 'updatedAt' | 'attemptCount'> & {
      status: 'EXPIRED' | 'FAILED_TERMINAL';
    },
  ): Promise<SafetyDeskDeleteRuntimeResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/deletes/${encodeURIComponent(item.id)}/retry`,
      safetyDeskDeleteRuntimeResponseSchema,
      {
        method: 'POST',
        body: {
          expectedStatus: item.status,
          expectedUpdatedAt: item.updatedAt,
          expectedAttemptCount: item.attemptCount,
        },
      },
    );
  }

  decide(itemId: string, action: SafetyDeskDecisionAction): Promise<SafetyDeskDecisionResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/items/${encodeURIComponent(itemId)}/${action}`,
      safetyDeskDecisionResponseSchema,
      { method: 'POST', body: {} },
    );
  }

  approveAll(itemIds: string[]): Promise<SafetyDeskDecisionResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/queue/approve-all`,
      safetyDeskDecisionResponseSchema,
      { method: 'POST', body: { itemIds } },
    );
  }
}

export const safetyDeskApiClient = new SafetyDeskApiClient();
