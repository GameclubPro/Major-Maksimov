import {
  supportRequestDecisionResponseSchema,
  supportRequestQueueResponseSchema,
  type SupportRequestDecisionResponse,
  type SupportRequestQueueResponse,
} from '@maxim/contracts/support-requests';
import { createAdminApiTransport, type AdminApiTransport } from './admin-request';

const SUPPORT_REQUESTS_API_BASE = '/api/v1/support-requests';

export class SupportRequestsApiClient {
  constructor(private readonly transport: AdminApiTransport = createAdminApiTransport()) {}

  fetchQueue(): Promise<SupportRequestQueueResponse> {
    return this.transport.request(
      `${SUPPORT_REQUESTS_API_BASE}/queue`,
      supportRequestQueueResponseSchema,
    );
  }

  close(itemId: string): Promise<SupportRequestDecisionResponse> {
    return this.transport.request(
      `${SUPPORT_REQUESTS_API_BASE}/items/${encodeURIComponent(itemId)}/close`,
      supportRequestDecisionResponseSchema,
      { method: 'POST', body: {} },
    );
  }
}

export const supportRequestsApiClient = new SupportRequestsApiClient();
