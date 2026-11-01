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
} from '@maxim/contracts/safety-desk';
import { createAdminApiTransport, type AdminApiTransport } from './admin-request';

const SAFETY_DESK_API_BASE = '/api/v1/safety-desk';

export type SafetyDeskDecisionAction = 'approve' | 'reject' | 'recheck';

export class SafetyDeskApiClient {
  constructor(private readonly transport: AdminApiTransport = createAdminApiTransport()) {}

  fetchCommercialReview(
    accessCode: string,
    cursor?: string,
    status: 'PENDING' | 'REVIEWED' | 'ALL' = 'PENDING',
  ): Promise<CommercialReviewQueueResponse> {
    const query = new URLSearchParams({ limit: '50', status, ...(cursor ? { cursor } : {}) });
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/commercial/review?${query}`,
      accessCode,
      commercialReviewQueueResponseSchema,
    );
  }

  labelCommercialReview(
    item: CommercialReviewItem,
    label: CommercialReviewLabel,
    reason: string,
    accessCode: string,
    expectedDisposition: 'KEEP' | 'DELETE' | null = label === 'COMMERCIAL'
      ? 'DELETE'
      : label === 'NOT_COMMERCIAL'
        ? 'KEEP'
        : null,
    semanticAnnotation?: CommercialReviewSemanticAnnotationRequest,
  ): Promise<CommercialReviewItem> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/commercial/review/${encodeURIComponent(item.id)}/label`,
      accessCode,
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
    accessCode: string,
    expectedDisposition: 'KEEP' | 'DELETE' | null,
    semanticAnnotation?: CommercialReviewSemanticAnnotationRequest,
  ): Promise<CommercialReviewItem> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/commercial/review/${encodeURIComponent(item.id)}/adjudicate`,
      accessCode,
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

  fetchQueue(accessCode: string): Promise<SafetyDeskQueueResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/queue`,
      accessCode,
      safetyDeskQueueResponseSchema,
    );
  }

  fetchDeleteRuntime(accessCode: string): Promise<SafetyDeskDeleteRuntimeResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/deletes`,
      accessCode,
      safetyDeskDeleteRuntimeResponseSchema,
    );
  }

  fetchCommercialAiRuntime(accessCode: string): Promise<SafetyDeskCommercialAiResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/commercial-ai`,
      accessCode,
      safetyDeskCommercialAiResponseSchema,
    );
  }

  fetchCommercialAiPoolRuntime(accessCode: string): Promise<SafetyDeskCommercialAiPoolResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/commercial-ai/pool`,
      accessCode,
      safetyDeskCommercialAiPoolResponseSchema,
    );
  }

  async fetchDeleteEvidence(
    intentId: string,
    accessCode: string,
  ): Promise<SafetyDeskDeleteEvidenceResponse> {
    const snapshot = await this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/deletes/${encodeURIComponent(intentId)}/evidence`,
      accessCode,
      safetyDeskDeleteEvidenceResponseSchema,
    );
    if (snapshot.intentId !== intentId)
      throw new Error('Подтверждения относятся к другому удалению.');
    return snapshot;
  }

  fetchWebhookCohort(accessCode: string): Promise<SafetyDeskWebhookCohortResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/webhook-cohort`,
      accessCode,
      safetyDeskWebhookCohortResponseSchema,
    );
  }

  fetchPublicationCohort(accessCode: string): Promise<SafetyDeskPublicationCohortResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/publication-cohort`,
      accessCode,
      safetyDeskPublicationCohortResponseSchema,
    );
  }

  fetchDeleteCohort(accessCode: string): Promise<SafetyDeskDeleteCohortResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/delete-cohort`,
      accessCode,
      safetyDeskDeleteCohortResponseSchema,
    );
  }

  fetchPublicationDeliveryCohort(
    accessCode: string,
  ): Promise<SafetyDeskPublicationDeliveryCohortResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/publication-delivery-cohort`,
      accessCode,
      safetyDeskPublicationDeliveryCohortResponseSchema,
    );
  }

  async fetchPublicationDeliveryEvidence(
    deliveryId: string,
    accessCode: string,
  ): Promise<SafetyDeskPublicationDeliveryEvidenceResponse> {
    const snapshot = await this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/publication-deliveries/${encodeURIComponent(deliveryId)}/evidence`,
      accessCode,
      safetyDeskPublicationDeliveryEvidenceResponseSchema,
    );
    if (snapshot.deliveryId !== deliveryId)
      throw new Error('Подтверждения относятся к другой доставке.');
    return snapshot;
  }

  fetchRetentionRuntime(
    accessCode: string,
    after: string | null = null,
  ): Promise<SafetyDeskRetentionRuntimeResponse> {
    const cursor = after ? `?after=${encodeURIComponent(after)}` : '';
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/retention${cursor}`,
      accessCode,
      safetyDeskRetentionRuntimeResponseSchema,
    );
  }

  fetchRetentionPreview(
    chatId: string,
    accessCode: string,
    after: string | null = null,
  ): Promise<SafetyDeskRetentionPreviewResponse> {
    const cursor = after ? `?after=${encodeURIComponent(after)}` : '';
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/retention/${encodeURIComponent(chatId)}/preview${cursor}`,
      accessCode,
      safetyDeskRetentionPreviewResponseSchema,
    );
  }

  retryRetention(
    chatId: string,
    request: SafetyDeskRetryRetentionRequest,
    accessCode: string,
  ): Promise<SafetyDeskRetentionPreviewResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/retention/${encodeURIComponent(chatId)}/retry`,
      accessCode,
      safetyDeskRetentionPreviewResponseSchema,
      { method: 'POST', body: safetyDeskRetryRetentionRequestSchema.parse(request) },
    );
  }

  allowAmbiguousSendRetry(
    item: SafetyDeskDeleteRuntimeResponse['ambiguousSends'][number],
    accessCode: string,
  ): Promise<SafetyDeskDeleteRuntimeResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/ambiguous-sends/${encodeURIComponent(item.id)}/allow-retry`,
      accessCode,
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
    accessCode: string,
  ): Promise<SafetyDeskDeleteRuntimeResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/deletes/${encodeURIComponent(item.id)}/retry`,
      accessCode,
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

  decide(
    itemId: string,
    action: SafetyDeskDecisionAction,
    accessCode: string,
  ): Promise<SafetyDeskDecisionResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/items/${encodeURIComponent(itemId)}/${action}`,
      accessCode,
      safetyDeskDecisionResponseSchema,
      { method: 'POST', body: {} },
    );
  }

  approveAll(itemIds: string[], accessCode: string): Promise<SafetyDeskDecisionResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/queue/approve-all`,
      accessCode,
      safetyDeskDecisionResponseSchema,
      { method: 'POST', body: { itemIds } },
    );
  }
}

export const safetyDeskApiClient = new SafetyDeskApiClient();
