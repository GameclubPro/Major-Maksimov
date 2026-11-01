import { ApiRequestError } from '../../../lib/api-request-error';

const editableShopRejectionCodes = new Set([
  'MARKETPLACE_FORMAT_LIMIT',
  'ADMINISTRATION_STORE_OWNER_REQUIRED',
  'ADMINISTRATION_STORE_REQUIRED',
  'ADMINISTRATION_STORE_NOT_READY',
  'PLACEMENT_REVIEW_REQUIRED',
  'SELLER_STOREFRONT_LIMIT',
  'MARKETPLACE_NETWORK_LIMIT',
  'MARKETPLACE_LIMIT',
  'MARKETPLACE_CHAT_REQUIRED',
  'MARKETPLACE_EMPTY_CONFIRMATION',
  'MARKETPLACE_RULES_ACCEPTANCE_REQUIRED',
]);

export function shopMutationFailureKind(
  error: unknown,
): 'validation' | 'refresh' | 'forbidden' | 'unknown' {
  if (!(error instanceof ApiRequestError)) return 'unknown';
  if (error.code === 'KARAVAN_COMMAND_UNKNOWN') return 'unknown';
  if (error.code === 'KARAVAN_COMMAND_REJECTED') return 'refresh';
  if (error.status >= 500) return 'unknown';
  if (
    [400, 403, 409, 422].includes(error.status) &&
    error.code &&
    editableShopRejectionCodes.has(error.code)
  )
    return 'validation';
  if (error.status === 401 || error.status === 403 || error.code === 'MARKETPLACE_BINDING_CHANGED')
    return 'forbidden';
  if (
    error.status === 404 ||
    error.status === 409 ||
    error.code === 'MARKETPLACE_RULES_DATE_INVALID'
  )
    return 'refresh';
  if (error.status === 400 || error.status === 422) return 'validation';
  return 'unknown';
}

export function isDefiniteFirstShopRejection(error: unknown, dispatchCount: number): boolean {
  if (dispatchCount !== 1 || !(error instanceof ApiRequestError)) return false;
  if (error.code === 'KARAVAN_COMMAND_UNKNOWN' || error.code === 'MARKETPLACE_COMMAND_CONFLICT')
    return false;
  if (error.code === 'KARAVAN_COMMAND_REJECTED') return true;
  if (![400, 401, 403, 404, 409, 422].includes(error.status)) return false;
  if (!error.code) return error.status === 400 || error.status === 422;
  if (editableShopRejectionCodes.has(error.code)) return true;
  return [
    'MARKETPLACE_REVISION_CONFLICT',
    'MARKETPLACE_BINDING_CHANGED',
    'MARKETPLACE_IMPACT_CHANGED',
    'MARKETPLACE_SELF_REVIEW',
    'MARKETPLACE_INDEPENDENT_REVIEW_REQUIRED',
    'MARKETPLACE_APPLICATION_STALE',
    'MARKETPLACE_APPLICATION_ALREADY_DECIDED',
    'MARKETPLACE_APPLICATION_NOT_FOUND',
    'PLACEMENT_NOT_FOUND',
    'MARKETPLACE_RULES_NOTICE_REQUIRED',
    'MARKETPLACE_RULES_ALREADY_SCHEDULED',
    'MARKETPLACE_RULES_DATE_INVALID',
    'MARKETPLACE_RULES_UNAVAILABLE',
    'MARKETPLACE_FORBIDDEN',
    'MARKETPLACE_CATEGORIES_INVALID',
    'MARKETPLACE_PIN_UNAVAILABLE',
    'MARKETPLACE_IMAGE_INVALID',
    'MARKETPLACE_CONTENT_NOT_FOUND',
    'MARKETPLACE_ORDER_CHANGED',
    'MARKETPLACE_REORDER_INVALID',
    'MARKETPLACE_STATUS_INVALID',
    'MARKETPLACE_FORMAT_CHANGED',
    'MARKETPLACE_ARCHIVED',
  ].includes(error.code);
}
