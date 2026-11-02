#!/usr/bin/env bash

# shellcheck source=infra/scripts/lib/photo-native-lifecycle.sh
source "$(dirname "${BASH_SOURCE[0]}")/photo-native-lifecycle.sh"

MAXIM_PRODUCTION_API_SERVICES=(
  "api-ingress"
  "api-admin"
  "api-enqueue"
  "api-moderation"
  "api-moderation-critical"
  "api-moderation-join"
  "api-moderation-realtime-b"
  "api-moderation-realtime-c"
  "api-moderation-realtime-d"
  "api-moderation-background"
  "api-media-analysis"
  "api-action"
  "api-publisher"
  "api-message-retention"
)

MAXIM_MEDIA_ANALYSIS_SERVICE="api-media-analysis"
MAXIM_OCR_NATIVE_SANDBOX_SERVICE="ocr-native-sandbox"
MAXIM_OCR_NATIVE_SANDBOX_CAPABILITY_LABEL="com.maxim.ocr-native-sandbox-capable"
MAXIM_IMAGE_TEXT_STOP_LIST_BINDING_SOURCE="apps/api/src/moderation/commercial-ocr/image-text-stop-list-binding.ts"
MAXIM_IMAGE_TEXT_STOP_LIST_DELETE_EXECUTOR_SOURCE="apps/api/src/moderation/moderation-delete-intent.service.ts"
MAXIM_PUBLISHER_SERVICE="api-publisher"
MAXIM_PUBLISHER_SECRET_FILES=(
  "/var/lib/maxim-secrets/publik-bot-token"
  "/var/lib/maxim-secrets/publik-webhook.json"
  "/var/lib/maxim-secrets/publik-init-data-keys.json"
  "/var/lib/maxim-secrets/publik-dialog-signing-keys.json"
)

maxim_topology_require_publisher_secret_files() {
  local path
  local mode
  local size

  for path in "${MAXIM_PUBLISHER_SECRET_FILES[@]}"; do
    if [[ ! -f "$path" || -L "$path" ]]; then
      echo "Publisher runtime secret file is missing or unsafe: $path" >&2
      return 1
    fi
    mode="$(stat -c '%a' "$path" 2>/dev/null || true)"
    size="$(stat -c '%s' "$path" 2>/dev/null || true)"
    if [[ "$mode" != "600" || ! "$size" =~ ^[1-9][0-9]{0,4}$ || "$size" -gt 16384 ]]; then
      echo "Publisher runtime secret file must be a bounded regular 0600 file: $path" >&2
      return 1
    fi
  done
}

maxim_topology_contains() {
  local needle="$1"
  shift
  local item
  for item in "$@"; do
    if [[ "$item" == "$needle" ]]; then
      return 0
    fi
  done
  return 1
}

maxim_topology_is_api_service() {
  maxim_topology_contains "$1" "${MAXIM_PRODUCTION_API_SERVICES[@]}"
}

maxim_topology_remove_service() {
  local services_var="$1"
  local removed_service="$2"
  local -n services_ref="$services_var"
  local service
  local filtered=()

  for service in "${services_ref[@]}"; do
    [[ "$service" == "$removed_service" ]] || filtered+=("$service")
  done
  services_ref=("${filtered[@]}")
}

maxim_topology_git_compose_has_service() {
  local commit_sha="$1"
  local service="$2"
  local compose_path="infra/docker-compose.yml"

  if ! git cat-file -e "${commit_sha}:${compose_path}" 2>/dev/null; then
    echo "Target commit is missing $compose_path: $commit_sha" >&2
    return 2
  fi
  git show "${commit_sha}:${compose_path}" | awk -v service="$service" '
    {
      line = $0
      sub(/[[:space:]]+$/, "", line)
      if (line == "  " service ":") {
        found = 1
      }
    }
    END { exit found ? 0 : 1 }
  '
}

maxim_topology_git_has_commercial_ocr_raster_smoke() {
  local commit_sha="$1"

  git cat-file -e \
    "${commit_sha}:apps/api/src/scripts/smoke-commercial-ocr-worker.ts" 2>/dev/null
}

maxim_topology_git_has_ocr_native_sandbox() {
  maxim_topology_git_compose_has_service "$1" "$MAXIM_OCR_NATIVE_SANDBOX_SERVICE"
}

maxim_topology_require_image_text_stop_list_delete_guard() {
  local commit_sha="$1"
  local binding_source
  local executor_source
  local source_path

  for source_path in \
    "$MAXIM_IMAGE_TEXT_STOP_LIST_BINDING_SOURCE" \
    "$MAXIM_IMAGE_TEXT_STOP_LIST_DELETE_EXECUTOR_SOURCE"; do
    if ! git cat-file -e "${commit_sha}:${source_path}" 2>/dev/null; then
      echo "Rollback target predates the image-text stop-list delete guard." >&2
      return 1
    fi
  done
  if ! binding_source="$(
    git show "${commit_sha}:${MAXIM_IMAGE_TEXT_STOP_LIST_BINDING_SOURCE}" 2>/dev/null
  )"; then
    echo "Could not inspect the rollback target image-text binding source." >&2
    return 1
  fi
  if ! executor_source="$(
    git show "${commit_sha}:${MAXIM_IMAGE_TEXT_STOP_LIST_DELETE_EXECUTOR_SOURCE}" 2>/dev/null
  )"; then
    echo "Could not inspect the rollback target delete executor source." >&2
    return 1
  fi

  # FLAG: The JavaScript parser matches quote literals, including backticks, without shell expansion.
  # shellcheck disable=SC2016
  if ! printf '%s\0%s' "$binding_source" "$executor_source" | node -e '
      const { readFileSync } = require("node:fs");
      const input = readFileSync(0);
      if (input.byteLength < 1 || input.byteLength > 4 * 1024 * 1024) process.exit(1);
      const separator = input.indexOf(0);
      if (separator < 1 || input.indexOf(0, separator + 1) !== -1) process.exit(1);
      const binding = input.subarray(0, separator).toString("utf8");
      const executor = input.subarray(separator + 1).toString("utf8");
      const exactCount = (source, expression) => [...source.matchAll(expression)].length;
      const bindingVersion =
        /export const IMAGE_TEXT_STOP_LIST_BINDING_VERSION\s*=\s*1\s+as\s+const;/gu;
      const methodDefinition =
        /private async assertImageTextStopListDeleteIntentStillActionable\s*\(/gu;
      const methodCall =
        /await\s+this\.assertImageTextStopListDeleteIntentStillActionable\(\s*intent,\s*botId\s*,?\s*\);/gu;
      // FLAG: Accept the legacy void guard or the value-returning guard with its
      // exact absence rejection. A bare call must not discard an absent result.
      const legacyVoidDefinition =
        /private async assertImageTextStopListDeleteIntentStillActionable\(\s*intent:\s*IntentRow,\s*botId:\s*string\s*,?\s*\):\s*Promise<void>\s*\{/gu;
      const legacyCall =
        /(?:^|\n)\s*await\s+this\.assertImageTextStopListDeleteIntentStillActionable\(\s*intent,\s*botId\s*,?\s*\);/gu;
      const checkedCall =
        /(?:^|\n)\s*const imageTextStopListGuard\s*=\s*await\s+this\.assertImageTextStopListDeleteIntentStillActionable\(\s*intent,\s*botId\s*,?\s*\);\s*if\s*\(imageTextStopListGuard\s*===\s*\x27absent\x27\)\s*\{\s*throw new ModerationDeleteGuardedMessageAbsentError\(\s*\x27guarded_image_text_stop_list_predispatch_exact_absence\x27\s*,?\s*\);\s*\}/gu;
      if (
        exactCount(binding, bindingVersion) !== 1 ||
        exactCount(executor, methodDefinition) !== 1 ||
        exactCount(executor, methodCall) !== 1 ||
        exactCount(
          executor,
          /from\s+[\x22\x27]\.\/commercial-ocr\/image-text-stop-list-binding[\x22\x27];/gu,
        ) !== 1
      ) process.exit(1);
      const guardStart = executor.indexOf("private async runDeletePreDispatchGuards(");
      const guardEnd = executor.indexOf("\n  private ", guardStart + 1);
      const callAt = executor.search(methodCall);
      // FLAG: Both the legacy no-argument callback and the explicit dispatch-phase
      // callback must follow the exact image guard and its absence rejection.
      const dispatchAt = executor.indexOf("await options?.beforeDeleteMutation?.(", guardStart);
      const checked = [...executor.matchAll(checkedCall)];
      const resultHandled = checked.length === 1 && checked[0].index > guardStart &&
        checked[0].index + checked[0][0].length < dispatchAt;
      const legacyVoid = exactCount(executor, legacyVoidDefinition) === 1 &&
        exactCount(executor, legacyCall) === 1;
      const code = (source) => source.replace(/("(?:\\.|[^"\\])*"|\u0027(?:\\.|[^\u0027\\])*\u0027|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu,
        (match, literal) => literal ?? "").replace(/\s+/gu, " ").trim();
      const boundary = code(executor.slice(guardStart, guardEnd));
      const preparationStart = executor.indexOf("private async prepareImageTextStopListDeleteAuthority(");
      const preparationEnd = executor.indexOf("\n  private ", preparationStart + 1);
      const preparation = code(executor.slice(preparationStart, preparationEnd));
      const compatibilityStart = executor.search(methodDefinition);
      const compatibilityEnd = executor.indexOf("\n  private ", compatibilityStart + 1);
      const compatibility = code(executor.slice(compatibilityStart, compatibilityEnd));
      const composed = boundary.indexOf("const proof = await this.authorizeGuardedUserDeleteReasons(");
      const preparedAbsence = boundary.indexOf("if (imageTextStopListGuard === \u0027absent\u0027) { throw new ModerationDeleteGuardedMessageAbsentError( \u0027guarded_image_text_stop_list_predispatch_exact_absence\u0027,");
      const caller = boundary.indexOf("await options?.beforeDeleteMutation?.(");
      // FLAG: Prepared authority must be consumed by the awaited composer after its
      // checkpoint. A decoy preparation or a discarded exact-absence result is insufficient.
      const prepared = preparationStart >= 0 && preparationEnd > preparationStart &&
        exactCount(executor, /private async prepareImageTextStopListDeleteAuthority\s*\(/gu) === 1 &&
        /const imageTextPreparation = finalDispatchLeaseToken \? await this\.prepareImageTextStopListDeleteAuthority\(\s*intent,\s*botId\s*,?\s*\) : await this\.assertImageTextStopListDeleteIntentStillActionable\(\s*intent,\s*botId\s*,?\s*\);/u.test(boundary) &&
        boundary.includes("let imageTextStopListGuard = isPreparedDeleteAuthority(imageTextPreparation) ? undefined : imageTextPreparation;") &&
        preparedAbsence >= 0 && caller > preparedAbsence && composed > caller &&
        boundary.slice(composed).includes("async () => { await beforeFinalAuthority?.(); imageTextStopListGuard = await finalizeDeleteAuthority(imageTextPreparation);") &&
        exactCount(boundary, /imageTextStopListGuard = await finalizeDeleteAuthority\(imageTextPreparation\);/gu) === 1 &&
        compatibilityStart >= 0 && compatibilityEnd > compatibilityStart &&
        /return finalizeDeleteAuthority\(\s*await this\.prepareImageTextStopListDeleteAuthority\(\s*intent,\s*botId\s*,?\s*\)\s*,?\s*\);/u.test(compatibility) &&
        boundary.includes("await this.assertImageTextStopListDispatchDeadline( intent.id, finalDispatchLeaseToken, botId, );") &&
        boundary.includes("verifiedReasonKeys.push( ...imageTextStopListGuard.reasonDeadlines.map((permit) => permit.reasonKey), );") &&
        boundary.includes("verifiedReasonDeadlines.push(...imageTextStopListGuard.reasonDeadlines);") &&
        preparation.includes("const exactRow = await this.maxClient.getExactMessageRow(intent.chatId, intent.messageId,") &&
        /if \(!exactRow\) \{ return \u0027absent\u0027; \}/u.test(preparation) &&
        preparation.indexOf("if (!exactRow)") < preparation.indexOf("return prepareDeleteAuthority(async () => {") &&
        preparation.includes("deadlineAtMs: Date.parse(validBindings[index]!.deleteDeadlineAt)");
      const valid =
        guardStart >= 0 && guardEnd > guardStart && callAt > guardStart && callAt < guardEnd &&
        exactCount(executor, /private async runDeletePreDispatchGuards\s*\(/gu) === 1 &&
        dispatchAt > callAt && dispatchAt < guardEnd &&
        (preparationStart >= 0 ? prepared : resultHandled || legacyVoid);
      process.exit(valid ? 0 : 1);
    ' >/dev/null 2>&1; then
    echo "Rollback target lacks the reviewed image-text stop-list pre-dispatch guard capability." >&2
    return 1
  fi
}

# FLAG: A rollback cannot make durable parked receipts executable or erase their evidence.
maxim_topology_require_dependency_quarantine() {
  node - "$1" <<'NODE'
const { execFileSync } = require('node:child_process');
const sha = process.argv[2];
try {
  const read = (path) => execFileSync('git', ['show', `${sha}:${path}`], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const worker = read('apps/api/src/moderation/webhook-canonical-execution.service.ts');
  const ingress = read('apps/api/src/webhook/webhook.service.ts');
  const outbox = read('apps/api/src/webhook/webhook-outbox.service.ts');
  const schema = read('apps/api/prisma/schema.prisma');
  if (!worker.includes('webhookEvent.status === WebhookStatus.QUARANTINED') ||
      !worker.includes('latestWebhookEvent.status === WebhookStatus.QUARANTINED') ||
      !/event\."status" NOT IN \([^)]*'QUARANTINED'/u.test(worker) ||
      !worker.includes('webhook_dependency_quarantines') ||
      !ingress.includes('event.status === WebhookStatus.QUARANTINED') ||
      !outbox.includes('current.status === WebhookStatus.QUARANTINED') ||
      !outbox.includes('quarantine."blocker_id" = candidate."id"') ||
      !outbox.includes('quarantine."anchor_id" = candidate."id"') ||
      !schema.includes('model WebhookDependencyQuarantine')) throw new Error('missing readers');
} catch {
  process.stderr.write('Rollback target predates durable dependency-quarantine readers.\n');
  process.exit(1);
}
NODE
}

maxim_topology_require_multibot_authority() {
  local commit_sha="$1"
  local path source
  local sources=()
  for path in \
    apps/api/src/webhook/webhook-semantic-authority.ts \
    apps/api/src/webhook/webhook.service.ts \
    apps/api/src/moderation/webhook-canonical-execution.service.ts \
    apps/api/src/common/group-command-authority.service.ts \
    apps/api/src/max/max-mutation-outcome.util.ts \
    apps/api/src/max/max-client.service.ts \
    apps/api/prisma/schema.prisma \
    apps/api/src/common/group-command-notice-recovery.ts \
    apps/api/src/common/group-command-notice-delivery.ts \
    apps/api/src/moderation/moderation.service.legacy.ts \
    apps/api/src/webhook/webhook-outbox.service.ts \
    apps/api/src/webhook/webhook-legacy-authority.ts; do
    if ! source="$(git show "${commit_sha}:${path}" 2>/dev/null)"; then
      echo "Rollback target predates durable multibot authority: $path" >&2
      return 1
    fi
    sources+=("$source")
  done
  if ! printf '%s\0' "${sources[@]}" | node -e '
    const [version, ingress, worker, commands, outcome, client, schema,
      noticeRecovery, noticeDelivery, moderation, outbox, legacy] = require("node:fs").readFileSync(0).toString("utf8").split("\0");
    const claimModel = schema.match(/^model\s+WebhookExecutionClaim\s*\{([\s\S]*?)^\}/m)?.[1] ?? "";
    const claimRelation = claimModel.match(/\bwebhookEvent\s+WebhookEvent\?\s+@relation\(([^)]*)\)/u)?.[1] ?? "";
    const tombstoneSchema = /\bwebhookEventId\s+String\?\s+@map\("webhook_event_id"\)/u.test(claimModel) &&
      /\bfields:\s*\[webhookEventId\]/u.test(claimRelation) &&
      /\breferences:\s*\[id\]/u.test(claimRelation) && /\bonDelete:\s*SetNull\b/u.test(claimRelation);
    const handlerStart = moderation.indexOf("async processWebhookEvent(");
    const recoverNotice = moderation.indexOf("await recoverGroupCommandNotice(", handlerStart);
    const prepare = moderation.indexOf("this.webhookCanonicalExecutionService.prepareExecution(", handlerStart);
    const recordNotice = moderation.indexOf("await recordGroupCommandNoticeRecovery(", handlerStart);
    const releaseBusiness = moderation.indexOf("this.webhookCanonicalExecutionService.failExecution(", handlerStart);
    const retentionStart = outbox.indexOf("private webhookRetentionProofUnpinnedSql()");
    const retentionEnd = outbox.indexOf("\n  private ", retentionStart + 1);
    const retention = outbox.slice(retentionStart, retentionEnd);
    const requestStart = client.indexOf("private async request<T");
    const requestEnd = client.indexOf("private async requestAbsolute<T", requestStart);
    const request = client.slice(requestStart, requestEnd);
    const proof = request.indexOf("await this.assertChatMutationExecutionProof(");
    const quota = request.indexOf("await this.reserveRateLimitSlot(");
    const epoch = request.indexOf("verifyChatExecutionProof(");
    const feature = request.indexOf("await scope.finalGuard?.(");
    const attempt = request.indexOf("scope.onDispatchAttempt?.()");
    const dispatch = request.indexOf("this.httpService.request<T>(");
    const sourceStart = legacy.indexOf("function hasNewOriginalSource(");
    const sourceEnd = legacy.indexOf("\n}", sourceStart + 1);
    const squash = (source) => source.replace(/^\s*\/\/[^\r\n]*/gmu, "").replace(/\s+/gu, " ").trim();
    const originalSource = sourceStart >= 0 && sourceEnd > sourceStart ?
      squash(legacy.slice(sourceStart, sourceEnd + 2)) : "";
    const legacyAuthority = squash(legacy);
    // FLAG: Accept the strict historical bound or the fixed 1-second clock tolerance
    // only with sticky installed holds. A wider/missing bound cannot authorize rollback.
    const sourceClockBound = originalSource.includes("value !== null && value > cutoffMs && value <= ownerMs;") || (
      legacyAuthority.includes("const LEGACY_SOURCE_CLOCK_LEAD_MS = 1_000;") &&
      originalSource.includes("value !== null && value > cutoffMs && value <= ownerMs + LEGACY_SOURCE_CLOCK_LEAD_MS;") &&
      legacyAuthority.includes("hasNewOriginalSource(currentOwner, cutoff) && currentOwner.errorMessage !== LEGACY_EXECUTION_UNVERIFIED_MARKER") &&
      legacyAuthority.includes("const LEGACY_EXECUTION_UNVERIFIED_MARKER = \u0060\u0024{WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required\u0060;")
    );
    // FLAG: A new claim cannot certify an old off-mode receipt. Preserve owner birth,
    // original MAX source age and the indexed older-mirror exclusion on every rollback.
    const legacyNoReplay = legacyAuthority.includes(
      "currentOwner?.createdAt instanceof Date && Number.isFinite(currentOwner.createdAt.getTime()) && " +
      "currentOwner.createdAt.getTime() > cutoff.getTime() && " +
      "buildWebhookSemanticEventKey(currentOwner.normalizedPayload) === claim.semanticKey && " +
      "hasNewOriginalSource(currentOwner, cutoff)"
    ) && legacyAuthority.includes(
      "const oldMirror = await prisma.webhookEvent.findFirst({ " +
      "where: { semanticKey: claim.semanticKey, createdAt: { lte: cutoff } }, " +
      "orderBy: [{ createdAt: \u0027asc\u0027 }, { id: \u0027asc\u0027 }], select: { id: true }, " +
      "}); if (!oldMirror) return false;"
    ) && originalSource.includes("if (sourceMarker === \u0027ingress\u0027) return false;") &&
      originalSource.includes("if (!raw && sourceMarker !== \u0027payload\u0027) return false;") &&
      originalSource.includes("const source = raw ?? payload;") &&
      originalSource.includes("message: !raw || type === \u0027message_created\u0027 ? message : undefined,") &&
      originalSource.includes("const ownerMs = Math.min(owner.createdAt.getTime(), Date.now());") &&
      sourceClockBound &&
      originalSource.includes("if (!isNewSource(eventAt?.getTime() ?? null)) return false;") &&
      originalSource.includes("if (type === \u0027message_created\u0027 && message)") &&
      originalSource.includes("for (const field of [\u0027createdAt\u0027, \u0027created_at\u0027, \u0027timestamp\u0027])") &&
      originalSource.includes("!isNewSource(parseWebhookEventTimestampMs(message[field]))");
    const valid = version.includes("semantic-owner-lease-v1") &&
      ingress.includes("MULTIBOT_EXECUTION_AUTHORITY_VERSION") &&
      ingress.includes("await holdUnverifiedLegacyExecution(") &&
      ingress.includes("transitionLiveUnstartedOwnerWithClient(") &&
      ingress.includes("claim.webhookEventId === null") &&
      worker.includes("MULTIBOT_EXECUTION_AUTHORITY_VERSION") &&
      worker.includes("leaseToken") && worker.includes("semanticKey") && worker.includes("businessStartedAt") &&
      worker.includes("await holdUnverifiedLegacyExecution(") &&
      worker.includes("executionClaim?.webhookEventId === null") &&
      worker.includes("EXECUTION_FINISHED") && worker.includes("await this.tryRecoverFinishedExecution(") &&
      worker.includes("await this.markExecutionHandlerFinished(") &&
      worker.includes("static async transitionLiveUnstartedOwnerWithClient(") &&
      worker.includes("claim.\"lease_expires_at\" > instant.\"now\"") &&
      worker.includes("event.\"execution_deadline_at\" > instant.\"now\"") &&
      worker.includes("clock_timestamp() AT TIME ZONE") &&
      legacy.includes("async function holdUnverifiedLegacyExecution(") &&
      legacy.includes("LEGACY_EXECUTION_UNVERIFIED") &&
      legacy.includes("20261005020000_add_multibot_order_fences") &&
      legacy.includes("claim.createdAt.getTime() > cutoff.getTime()") &&
      legacyNoReplay &&
      commands.includes("buildGroupCommandKey") && commands.includes("commandResult") &&
      commands.includes("advanceChatMutationOrder") && commands.includes("leaseToken") &&
      noticeRecovery.includes("async function recoverGroupCommandNotice(") &&
      noticeRecovery.includes("async function recordGroupCommandNoticeRecovery(") &&
      noticeRecovery.includes("COMMAND_NOTICE_PENDING") && noticeRecovery.includes("COMMAND_NOTICE_EXPIRED") &&
      noticeRecovery.includes("isUnattemptedSend(") && noticeRecovery.includes("isCompletedSend(") &&
      noticeRecovery.includes("wasMaxPreDispatchGuardRejected(") && noticeRecovery.includes("wasMaxMessageSendAttempted(") &&
      noticeRecovery.includes("MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE") &&
      noticeRecovery.includes("commandResultDigest") && noticeRecovery.includes("executionDeadlineAt") &&
      noticeDelivery.includes("beforeImmediateSendMutation:") && noticeDelivery.includes("permit.executionDeadlineAt") &&
      noticeDelivery.includes("requiredBotId: permit.executionBotId") &&
      moderation.includes("../common/group-command-notice-recovery") && moderation.includes("await deliverGroupCommandNotice(") &&
      handlerStart >= 0 && recoverNotice > handlerStart && prepare > recoverNotice &&
      recordNotice > prepare && releaseBusiness > recordNotice &&
      retentionStart >= 0 && retentionEnd > retentionStart &&
      retention.includes("claim.\"webhook_event_id\" = candidate.\"id\"") &&
      retention.includes("claim.\"status\" <>") && retention.includes("claim.\"lease_token\" IS NOT NULL") &&
      retention.includes("claim.\"command_result\" IS NULL") &&
      retention.includes("mirror.\"semantic_key\" = candidate.\"semantic_key\"") &&
      outcome.includes("wasMaxMemberMutationConfirmed") && outcome.includes("status >= 500") &&
      client.includes("requiredBotId && bot.id !== requiredBotId") &&
      client.includes("mutationExecutionScope") && client.includes("private async executeMemberMutation<T>") &&
      client.includes("deferRateLimitReservation: true") &&
      requestStart >= 0 && requestEnd > requestStart && proof >= 0 && quota > proof &&
      epoch > quota && feature > epoch && attempt > feature && dispatch > attempt &&
      tombstoneSchema;
    process.exit(valid ? 0 : 1);
  ' >/dev/null 2>&1; then
    echo "Rollback target lacks semantic leases, saved-journal readers, retained tombstones or mutation outcome fences." >&2
    return 1
  fi
}

maxim_topology_require_legacy_dispositions() {
  local commit_sha="$1"
  # FLAG: Permanent legacy source/member/global and child holds survive retention,
  # unban cleanup and both rollback mechanisms. A schema-compatible image is insufficient.
  node "$(dirname "${BASH_SOURCE[0]}")/../assert-legacy-disposition-source.mjs" "$commit_sha"
}

maxim_topology_require_fixed_moderator() {
  local commit_sha="$1"
  # FLAG: Never restore peer takeover after an administrator fixed a moderator.
  node "$(dirname "${BASH_SOURCE[0]}")/../assert-fixed-moderator-source.mjs" "$commit_sha"
}

maxim_topology_require_managed_network_foundation() {
  local commit_sha="$1"
  # FLAG: Installed operation journals and channel revisions survive feature-off.
  # Keep the runner, atomic COMMITTED receipts and every channel CAS writer wired.
  node "$(dirname "${BASH_SOURCE[0]}")/../assert-managed-network-foundation-source.mjs" "$commit_sha"
}

maxim_topology_require_network_settings_v2() {
  local commit_sha="$1"
  # FLAG: The stable v2 entrypoint retains v2 list intents and v3 supplementary
  # revisions, atomic policy/rules writes and COMMITTED settlement after UI disablement.
  node "$(dirname "${BASH_SOURCE[0]}")/../assert-network-settings-v2-source.mjs" "$commit_sha"
}

maxim_topology_require_exact_statistics_rollup_reader() {
  local commit_sha="$1" reader_source
  # FLAG: Saturated legacy compatibility columns must never reach an older API reader.
  # Nullable shadows preserve untouched history; changing the feature flag cannot lower this floor.
  if ! reader_source="$(git show "${commit_sha}:apps/api/src/admin/stats-read-model-selectors.ts" 2>/dev/null)"; then
    echo 'Rollback target predates the exact statistics rollup reader.' >&2
    return 1
  fi
  if ! printf '%s' "$reader_source" | node -e '
    const source=require("node:fs").readFileSync(0).toString("utf8");
    const valid=source.length<=262144 &&
      /export const EXACT_STATISTICS_ROLLUP_READER_VERSION\s*=\s*1\s*;/u.test(source) &&
      source.includes("export async function selectChannelStatsContentBucketRows(") &&
      source.includes("SUM(COALESCE(views_total_exact, views_total::bigint))");
    process.exit(valid?0:1);
  '; then
    echo 'Rollback target lacks the exact statistics rollup fallback reader.' >&2
    return 1
  fi
}

maxim_topology_require_statistics_authority_lifecycle() {
  local commit_sha="$1"
  # FLAG: Superseded statistics authorities are permanent tombstones. A schema-compatible
  # image must also retain the successor reader/writer fences after flags are disabled.
  node "$(dirname "${BASH_SOURCE[0]}")/../assert-statistics-authority-source.mjs" "$commit_sha"
}

maxim_topology_require_night_mode_recovery_reader() {
  local commit_sha="$1"
  # FLAG: SQL-backed opening-event and close-cleanup obligations survive image rollback.
  node "$(dirname "${BASH_SOURCE[0]}")/../assert-night-mode-recovery-source.mjs" "$commit_sha"
}

maxim_topology_require_statistics_and_night_mode_recovery() {
  local commit_sha="$1"
  # FLAG: Either earlier tooling branch lacks the other's permanent recovery floor.
  # The combined bootstrap capability must execute both checks for the same API source.
  maxim_topology_require_statistics_authority_lifecycle "$commit_sha" || return $?
  maxim_topology_require_night_mode_recovery_reader "$commit_sha" || return $?
}

maxim_topology_require_local_chat_ban_reader() {
  local commit_sha="$1"
  # FLAG: LOCAL_REJOIN survives image rollback; an older UNBAN can remove or add
  # a participant instead of clearing the local ban. Retain enforcement and release.
  node "$(dirname "${BASH_SOURCE[0]}")/../assert-local-chat-ban-source.mjs" "$commit_sha"
}

maxim_topology_require_managed_entity_activation() {
  local commit_sha="$1"
  # FLAG: Known denials, pending activation, capability ceilings and receipt-only
  # dormancy remain enforced even after an image rollback.
  node "$(dirname "${BASH_SOURCE[0]}")/../assert-managed-entity-activation-source.mjs" "$commit_sha"
}

maxim_topology_require_publication_policy() {
  local commit_sha="$1"
  # FLAG: New deadline and pending-context intents require compatible readers after rollback.
  node "$(dirname "${BASH_SOURCE[0]}")/../assert-publication-policy-source.mjs" "$commit_sha"
}

maxim_topology_require_bot_publisher_reliability() {
  local commit_sha="$1" path source
  local sources=()
  for path in \
    apps/api/src/max/max-action-ledger.service.ts \
    apps/api/src/moderation/moderation-delete-intent.service.ts \
    apps/api/src/moderation/moderation.service.legacy.ts \
    apps/api/src/moderation/moderation-execution-guard-callbacks.ts \
    apps/api/src/moderation/moderation-rule-sanction-authority.ts \
    apps/api/src/max/max-moderation-rule-notice.guard.ts \
    apps/api/src/max/max-client.service.ts \
    apps/api/src/max/max.module.ts \
    apps/api/src/max/max-required-subscription-notice.guard.ts \
    apps/api/src/moderation/required-subscription-notice-authority.ts \
    apps/api/src/moderation/required-subscription-notice-plan.ts \
    apps/api/src/moderation/moderation-state-delete-guard.service.ts \
    apps/api/src/max/max-duplicate-notice.guard.ts \
    apps/api/src/moderation/message-duplicate/message-duplicate-notice-proof.ts \
    apps/api/src/moderation/message-duplicate/message-duplicate-delete-guard.service.ts \
    apps/api/src/max/max-moderation-notice-envelope.ts \
    apps/api/src/admin/publication-execution-safety.ts \
    apps/api/src/admin/admin-managed-broadcast-ledger-recovery.ts \
    apps/api/src/publisher/publisher-video-upload.processor.ts \
    apps/api/src/admin/vk-sync-lease.ts \
    apps/api/src/publisher/publisher-auto-reply-delivery.service.ts \
    apps/api/src/admin/admin-chat-settings.ts \
    apps/api/src/moderation/moderation-rule-followup-persistence.ts \
    apps/api/src/moderation/moderation-rule-followup.service.ts \
    apps/api/src/moderation/moderation-rule-followup-sanction.ts \
    apps/api/src/moderation/moderation-rule-followup-execution.ts \
    apps/api/src/moderation/moderation.module.ts \
    apps/api/src/moderation/commercial/commercial-delete-guard.service.ts \
    apps/api/src/moderation/moderation-sanction-notice-delivery.ts \
    apps/api/src/common/group-command-notice-delivery.ts \
    apps/api/src/admin/admin-manual-moderation-runtime.ts \
    apps/api/src/admin/admin-manual-group-command-notice-authority.ts \
    apps/api/src/moderation/night-mode-transition-delivery.service.ts \
    apps/api/src/system/max-action-ledger-watchdog.service.ts \
    apps/api/src/admin/manual-member-unban-attempt.ts \
    apps/api/src/moderation/voice-webhook-source.ts \
    apps/api/src/moderation/message-limits-delete-guard.service.ts \
    apps/api/src/webhook/webhook.service.ts; do
    if ! source="$(git show "${commit_sha}:${path}" 2>/dev/null)"; then
      echo "Rollback target predates shared member and Publisher reliability: $path" >&2
      return 1
    fi
    sources+=("$source")
  done
  # FLAG: A rollback must preserve shared unknown-member fences and immutable publication
  # receipts, final queued notice authority and saved unfinished rule follow-ups.
  # Unverified unban attempts remain crash-fenced and require the final live route proof;
  # their unknown outcomes cannot become safe terminal failures or queued recovery.
  # Diagnostic modes or a compatible schema alone cannot certify the executor.
  if ! printf '%s\0' "${sources[@]}" | node -e '
    const [member, intents, moderation, callbacks, authority, notices, client, maxModule,
      subscriptionNotices, subscriptionAuthority, subscriptionPlans,
      stateAuthority,
      duplicateNotices, duplicateNoticeProof, duplicateAuthority,
      noticeEnvelopes,
      editing, receipts, video, vk, replies, settings, followupPersistence,
      followupService, followupSanction, followupExecution, moderationModule,
      commercialAuthority, sanctionNoticeDelivery, commandNoticeDelivery,
      manualRuntime, manualAuthority, nightDelivery, watchdog, manualUnban,
      voiceSource, voiceGuard, voiceIngress] =
      require("node:fs").readFileSync(0).toString("utf8").split("\0");
    const readNamedSet = (source, name) =>
      new RegExp("const\\s+" + name + "\\b[^=;]*=\\s*new Set\\(\\s*\\[([^\\]]*)\\]\\s*\\)", "u")
        .exec(source)?.[1] ?? null;
    const irreversible = readNamedSet(member, "IRREVERSIBLE_ACTION_TYPES");
    const crashFenced = readNamedSet(member, "CRASH_FENCED_MEMBER_ACTION_TYPES");
    const ambiguousCapable = readNamedSet(watchdog, "AMBIGUOUS_CAPABLE_ACTION_TYPES");
    const recoverableMembers = readNamedSet(watchdog, "RECOVERABLE_MEMBER_ACTION_TYPES");
    const hasUnbanAttempt = (set) =>
      set !== null && /(?:\u0027TRY_UNBAN_MEMBER\u0027|\u0022TRY_UNBAN_MEMBER\u0022)/u.test(set);
    const squash = (source) => source.replace(/^\s*\/\/[^\r\n]*/gmu, "").replace(/\s+/gu, " ").trim();
    // FLAG: Legacy callbacks finish routing last. Marked callbacks reserve earlier and must
    // recheck the sanction and lease after that wait, without further awaited work.
    const finalUnbanGuard =
      /beforeImmediateMemberMutation:\s*async \(revalidateRoute\) => \{[\s\S]*?if \(await readTargetAccess\(\)\) throw new ModerationSanctionStateChangedError\(\);\s*await leaseGuard\.assertOwned\(\);\s*(?:\/\/[^\n]*\n\s*)*await revalidateRoute\?\.\(\);\s*(?:\/\/[^\n]*\n\s*)*\},/u.test(manualUnban) ||
      squash(manualUnban).includes("beforeImmediateMemberMutation: withMaxFinalAuthorityCheckpoint(async (beforeFinalAuthority) => { await leaseGuard.assertOwned(); if (await readTargetAccess()) throw new ModerationSanctionStateChangedError(); await beforeFinalAuthority?.(); await assertSanctionState({ chatId, targetUserId, releaseAction: \u0027UNBAN\u0027, expectedSanctionEventId, }); await leaseGuard.assertOwned(); }),");
    const valid = voiceSource.includes("persistVoiceSource(") &&
      voiceSource.includes("input.kind === \u0027invalidate\u0027") &&
      voiceSource.includes("VOICE_SOURCE_LIFETIME_MS = 5 * 60_000") &&
      voiceIngress.includes("await persistVoiceSource(tx, voiceSourceInput, webhookEventId)") &&
      voiceGuard.includes("source.invalidatedAt") &&
      voiceGuard.includes("voiceSourcePolicySha256") &&
      member.includes("pg_advisory_xact_lock") &&
      member.includes("Retained member action requires settlement") &&
      hasUnbanAttempt(irreversible) && hasUnbanAttempt(crashFenced) &&
      member.includes("AND \u0022action_type\u0022 IN (\u0027BAN_MEMBER\u0027, \u0027KICK_MEMBER\u0027, \u0027TRY_UNBAN_MEMBER\u0027)") &&
      member.includes("\u0024{job.actionType !== \u0027TRY_UNBAN_MEMBER\u0027}") &&
      hasUnbanAttempt(ambiguousCapable) && recoverableMembers !== null &&
      !hasUnbanAttempt(recoverableMembers) &&
      /if \(mayHaveStarted && AMBIGUOUS_CAPABLE_ACTION_TYPES\.has\(row\.actionType\)\) \{\s*await this\.applyOutcome\(row, MaxActionLedgerStatus\.AMBIGUOUS, summary, \{\s*ambiguous: true,\s*errorCode:[^\n]*\n\s*error:[^\n]*\n\s*outcome:\s*\u0027quarantined\u0027,\s*\}\);\s*return;\s*\}/u.test(watchdog) &&
      finalUnbanGuard &&
      intents.includes("closedChatDeleteGuard!.authorize") &&
      intents.includes("requiredSubscriptionExecutionGuard!.authorize") &&
      intents.includes("moderationDeleteVerified") &&
      intents.includes("recoverKnownOwnReasonReceipt(input, result)") &&
      moderation.includes("moderationRuleSanctionGuard!.assertAllowed") &&
      moderation.includes("createRuleSanctionGuards") &&
      callbacks.includes("botId: readProvenBotId()") &&
      callbacks.includes("botId: readSelectedBotId()") &&
      callbacks.includes("moderationRuleNotice: { version: 1, ...proof }") &&
      authority.includes("chatId_messageId:") &&
      authority.includes("intentId_reasonKey:") &&
      authority.includes("metadata.moderationDeleteVerified !== true") &&
      authority.includes("sourceAtMs + 5 * 60_000 !== proof.deadlineAtMs") &&
      /await load\(\);\s*(?:\/\/[^\n]*\n\s*)*await dependencies\.assertFinalOwnership\?\.\(\);\s*if\s*\(/u.test(authority) &&
      notices.includes("action.actionType !== \u0027SEND_MESSAGE\u0027") &&
      notices.includes("value.chatId !== action.chatId") &&
      notices.includes("assertModerationRuleSanctionAuthority(this.prisma, proof") &&
      client.includes("hasMaxModerationRuleNoticeProof(action)") &&
      client.includes("this.moderationRuleNoticeGuard.assertAllowed(") &&
      /mutationOptions,\s*finalNoticeGuard,/u.test(client) &&
      maxModule.includes("  MaxModerationRuleNoticeGuardService,") &&
      moderation.includes("createRequiredSubscriptionNoticeHandoff") &&
      callbacks.includes("plan.executionProof") &&
      callbacks.includes("ledgerContext: { requiredSubscriptionNotice: proof }") &&
      subscriptionNotices.includes("isMaxRequiredSubscriptionNoticeAction") &&
      subscriptionNotices.includes("assertRequiredSubscriptionNoticeAuthority(this.prisma, proof") &&
      subscriptionAuthority.includes("row.deadlineAtMs !== Number(row.sourceAtMs) + 5 * 60_000") &&
      subscriptionAuthority.includes("binding.moderationDeleteVerified !== true") &&
      subscriptionPlans.includes("executionProof: params.executionProof") &&
      subscriptionPlans.includes("readRequiredSubscriptionNoticeAuthority(parsed.executionProof)") &&
      stateAuthority.includes("intentId_reasonKey: { intentId: intent.id, reasonKey }") &&
      stateAuthority.includes("intent.sourceMessageAt?.getTime() !== params.sourceMessageAt.getTime()") &&
      duplicateNotices.includes("MESSAGE_DUPLICATE_NOTICE_AUTHORITY") &&
      duplicateNotices.includes("notice: proof,") &&
      duplicateNoticeProof.includes("binding.enforcementScope === \u0027full\u0027") &&
      duplicateNoticeProof.includes("deadlineAtMs <= binding.authorization.deadlineAtMs") &&
      duplicateAuthority.includes("receiptMetadata?.moderationDeleteVerified !== true") &&
      duplicateAuthority.includes("await params.beforeFinalAuthority?.()") &&
      client.includes("this.duplicateNoticeGuard.assertAllowed(") &&
      maxModule.includes("  MaxDuplicateNoticeGuardService,") &&
      noticeEnvelopes.includes("moderation_notice_legacy_envelope_unverified") &&
      client.includes("assertMaxModerationNoticeEnvelope(action)") &&
      callbacks.includes("moderationNoticeEnvelope: { version: 1 }") &&
      client.includes("this.requiredSubscriptionNoticeGuard.assertAllowed(") &&
      maxModule.includes("  MaxRequiredSubscriptionNoticeGuardService,") &&
      editing.includes("reviseUnstartedPublicationExecutionBroadcasts") &&
      editing.includes("revised.count !== broadcastIds.length") &&
      receipts.includes("delivery.contentRevisionId") &&
      video.includes("assertPublisherIdentityOrDelay(this.identity, job, token)") &&
      vk.includes("syncAttemptCount") && vk.includes("FOR UPDATE OF source") &&
      vk.includes("clock_timestamp() AT TIME ZONE") &&
      replies.includes("confirmedRemoteMessageId") &&
      replies.includes("completeSent(delivery, dispatchStartedAt, sent.messageId)") &&
      replies.includes("PublisherAutoReplyDeliveryStatus.AMBIGUOUS") &&
      /return this\.assertFinalAutoReplyEpochAndBinding\(tx,\s*delivery,\s*lockToken\)/u.test(replies) &&
      replies.includes("publisher_auto_reply_send_fence_lock") &&
      replies.includes("publisher_auto_reply_send_fence_cas") &&
      replies.includes("publisher_auto_reply_send_fence_cooldown") &&
      replies.includes("admitted.\u0022dispatchStartedAt\u0022 +") &&
      replies.includes("OR EXISTS (SELECT 1 FROM cooldown)") &&
      replies.includes("\u0022publisher_auto_reply_cooldowns\u0022.\u0022next_allowed_at\u0022 <= (clock_timestamp() AT TIME ZONE") &&
      replies.includes("FOR UPDATE") &&
      replies.includes("binding.\u0022bot_access_state\u0022::text = " + String.fromCharCode(36) + "{binding.botAccessState}") &&
      replies.includes("binding.\u0022bot_access_checked_at\u0022 <= clock.\u0022now\u0022") &&
      replies.includes("rule.\u0022version\u0022 = delivery.\u0022matched_rule_version\u0022") &&
      replies.includes("settings.\u0022auto_reply_config_revision\u0022 = delivery.\u0022auto_reply_config_revision\u0022") &&
      intents.includes("persistIntent(input, false, tx)") &&
      /persistRuleFollowupBeforeDelete\(\s*tx,/u.test(intents) &&
      intents.includes("activateOwnedRuleFollowups(tx,") &&
      intents.includes("followup.\u0022effects\u0022->>\u0027phase\u0027 IN (\u0027BAN_STARTED\u0027, \u0027UNKNOWN\u0027)") &&
      followupPersistence.includes("intent.\u0022delete_dispatch_started_at\u0022 IS NULL") &&
      followupPersistence.includes("reason.\u0022metadata\u0022->\u0027moderationDeleteVerified\u0027 = \u0027true\u0027::jsonb") &&
      followupService.includes("roleRunsAction(getAppRole())") &&
      followupService.includes("MODERATION_RULE_FOLLOWUP_EXECUTOR") &&
      followupService.includes("moderationViolationMessageClaim.create") &&
      followupService.includes("clock_timestamp() AT TIME ZONE") &&
      followupSanction.includes("state.phase === \u0027BAN_STARTED\u0027") &&
      followupSanction.includes("dependencies.recoverBanReceipt(actionKey)") &&
      followupSanction.includes("RuleFollowupBanOutcomeUnknownError") &&
      /host\.applyRuleFollowupSanction\(\s*durable,/u.test(followupExecution) &&
      followupExecution.includes("durable?.plan.action") &&
      moderation.includes("!journal.receiptOnly") &&
      moderation.includes("assertFinalOwnership:") &&
      /provide:\s*MODERATION_RULE_FOLLOWUP_EXECUTOR,\s*useExisting:\s*ModerationService/u.test(moderationModule) &&
      /phase:\s*\u0027SQL_COMMITTED\u0027,\s*eventId:\s*plan\.eventId/u.test(moderation) &&
      commercialAuthority.includes("this.issuedPermits.get(permit)") &&
      commercialAuthority.includes("await options.beforeFinalAuthority?.()") &&
      sanctionNoticeDelivery.includes("...input.noticeDispatchOptions") &&
      commandNoticeDelivery.includes("await revalidateRoute?.()") &&
      commandNoticeDelivery.includes("moderationNoticeEnvelope: { version: 1 }") &&
      manualRuntime.includes("if (params.ledger.outcome !== \u0027SUCCESS\u0027)") &&
      manualRuntime.includes("this.context.assertManualGroupCommandSuccessNoticeAuthority(") &&
      manualAuthority.includes("notice.lockToken !== input.lockToken") &&
      manualAuthority.includes("bypassCache: true") &&
      manualAuthority.includes("moderationEventId: { not: null }") &&
      /beforeImmediateSendMutation:\s*(?:withMaxFinalAuthorityCheckpoint\(\s*)?async \(revalidateRoute\) => \{\s*await revalidateRoute\?\.\(\);\s*await this\.assertCurrentTransitionState\(/u.test(nightDelivery) &&
      /\[\s*(?:\/\/[^\n]*\n\s*)*\u0027nightModeEnabled\u0027,\s*\u0027nightModeStartTimeMinutes\u0027,\s*\u0027nightModeEndTimeMinutes\u0027,\s*\u0027nightModeTimezone\u0027,[\s\S]*?advanceChatMutationOrder\(tx, params.chatId, \u0027CHAT_CONTROL\u0027\)/u.test(settings);
    process.exit(valid ? 0 : 1);
  ' >/dev/null 2>&1; then
    echo "Rollback target lacks member-effect, final-policy or immutable Publisher receipt fences." >&2
    return 1
  fi
}

maxim_topology_require_message_duplicate_delete_guard() {
  local commit_sha="$1"
  local source_path
  local source
  local sources=()
  local source_paths=(
    apps/api/src/moderation/message-duplicate/message-duplicate-delete-guard.service.ts
    apps/api/src/moderation/moderation-delete-intent.service.ts
    apps/api/src/moderation/message-duplicate/message-duplicate-state.ts
    apps/api/src/moderation/message-duplicate/message-duplicate-authorization.service.ts
    apps/api/src/moderation/message-duplicate/message-duplicate-state.module.ts
    apps/api/src/moderation/message-duplicate/message-duplicate-enforcement.service.ts
    apps/api/prisma/schema.prisma
    apps/api/prisma/migrations/20260930180000_add_duplicate_policy_revisions/migration.sql
    apps/api/src/moderation/message-duplicate/message-duplicate-admission.service.ts
    apps/api/src/moderation/message-duplicate/message-duplicate.queue.ts
    apps/api/src/moderation/rule-engine-duplicate-detector.ts
    apps/api/src/moderation/duplicate-phone-evidence.ts
    apps/api/src/moderation/message-duplicate/message-duplicate-content.ts
    apps/api/src/moderation/message-duplicate/message-duplicate-history.service.ts
    apps/api/src/moderation/message-duplicate/message-duplicate-window.script.ts
    packages/contracts/src/duplicate-settings.ts
    apps/api/src/moderation/duplicate-semantic-text.ts
    apps/api/src/moderation/message-duplicate/message-duplicate-publication-time.ts
    apps/api/src/webhook/webhook-semantic-event-key.ts
    apps/api/src/webhook/webhook-execution-deadline.ts
    apps/api/src/moderation/message-duplicate/message-duplicate-media.service.ts
    apps/api/src/moderation/message-duplicate/message-duplicate-recompression-index.ts
    apps/api/src/moderation/photo-duplicate/photo-duplicate-analysis.service.ts
    apps/api/src/moderation/photo-duplicate/photo-fingerprint.ts
    apps/api/src/moderation/photo-duplicate/photo-recompression.ts
    apps/api/src/moderation/photo-duplicate/photo-recompression-version.ts
    apps/api/src/moderation/redis-counter.service.ts
  )

  # FLAG: Pending v3 decisions outlive environment downgrades. Both rollback paths
  # must retain lifecycle revisions, durable first admission/revocation and the last permit fence.
  # Bounded phone labels, strong identifier/quantity guards and original-text phone-before-URL
  # normalization remain mandatory with v14 text fences, v8 phone evidence and bounded v4 history with retained v3 negative fences.
  # Case-sensitive quantity units before/after values and finite phone authority must survive
  # exact/near matching and lifecycle identity.
  # FLAG: Retained single-image recompression grants require both exact hashes, independent
  # native proof and the accepted original anchor. A candidate hash never becomes authority.
  for source_path in "${source_paths[@]}"; do
    if ! source="$(git show "${commit_sha}:${source_path}" 2>/dev/null)"; then
      echo "Rollback target predates the message duplicate v3 action guard." >&2
      return 1
    fi
    sources+=("$source")
  done
  # FLAG: JavaScript compares literal TypeScript template expressions, not shell variables.
  # shellcheck disable=SC2016
  if ! printf '%s\0' "${sources[@]}" | node -e '
    const input = require("node:fs").readFileSync(0);
    if (input.length > 4 * 1024 * 1024) process.exit(1);
    const parts = input.toString("utf8").split("\0");
    if (parts.length !== 28 || parts.pop() !== "") process.exit(1);
    const [guard, executor, state, authorization, module, enforcement, schema, migration, admission, queue, detector, phones, content, history, window, settings, semantic, publicationTime, semanticKey, executionDeadline, media, recompressionIndex, photoAnalysis, photoFingerprint, photoRecompression, recompressionVersion, counters] = parts;
    const stripComments = (source) => source.replace(/("(?:\\.|[^"\\])*"|\u0027(?:\\.|[^\u0027\\])*\u0027|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu,
      (match, literal) => literal ?? "");
    const method = (source, marker) => {
      const start = source.indexOf(marker);
      const end = source.indexOf("\n  private ", start + 1);
      return start >= 0 && end > start && source.indexOf(marker, start + marker.length) === -1
        ? source.slice(start, end) : "";
    };
    const topLevelFunction = (source, marker) => {
      const start = source.indexOf(marker);
      const tail = source.slice(start + marker.length);
      const closing = tail.search(/\n\}(?=\r?\n|$)/u);
      const end = closing < 0 ? -1 : start + marker.length + closing;
      return start >= 0 && end > start ? source.slice(start, end + 2) : "";
    };
    const classMethod = (source, marker) => {
      const start = source.indexOf(marker);
      if (start < 0) return "";
      const tail = source.slice(start + marker.length);
      const boundary = tail.search(/\n  (?:(?:private|public|protected) )?(?:async )?[A-Za-z][A-Za-z0-9]*\(|\n\}/u);
      return boundary >= 0 ? source.slice(start, start + marker.length + boundary) : "";
    };
    const count = (source, marker) => source.split(marker).length - 1;
    const squash = (source) => source.replace(/^\s*\/\/[^\r\n]*/gmu, "").replace(/\s+/gu, " ").trim();
    const start = executor.indexOf("private async runDeletePreDispatchGuards(");
    const end = executor.indexOf("\n  private ", start + 1);
    const boundary = stripComments(method(executor, "private async runDeletePreDispatchGuards("));
    const check = method(guard, "private async checkMessage(");
    const reasons = stripComments(method(executor, "private async authorizeGuardedUserDeleteReasons("));
    const returnsDuplicateQualification = (source) => /return\s*\{[^}]*\bmessageDuplicateVerified\s*,/u.test(source);
    const preparedReasons = squash(reasons).includes("const candidates: Candidate[] = [];");
    const preparedQualification = preparedReasons &&
      squash(reasons).includes("await prepare( () => this.messageDuplicateDeleteGuard!.assertIntentStillActionable(params), receipts.map((r) => r.reasonKey), \u0027duplicate\u0027, receipts, );") &&
      squash(reasons).includes("const preparation = await run();") &&
      squash(reasons).includes("candidates.push({ preparation, keys, tag, fixedDeadlines });") &&
      squash(reasons).includes("const result = await finalizeDeleteAuthority(candidate.preparation);") &&
      /if \(result !== \u0027allowed\u0027 && \(typeof result !== \u0027object\u0027 \|\| result === null\)\)/u.test(squash(reasons)) &&
      squash(reasons).includes("if (candidate.tag === \u0027duplicate\u0027) messageDuplicateVerified = true;") &&
      count(reasons, "await beforeFinalAuthority?.();") === 1 &&
      reasons.indexOf("await beforeFinalAuthority?.();") >= 0 &&
      reasons.indexOf("await beforeFinalAuthority?.();") < reasons.indexOf("const finalizeCandidates = async (") &&
      reasons.includes("return finalizeCandidates(candidates, true);");
    const legacyQualification =
      squash(reasons).includes("messageDuplicateVerified = (await check(() => this.messageDuplicateDeleteGuard!.assertIntentStillActionable(params), )) === \u0027allowed\u0027;") ||
      squash(reasons).includes("messageDuplicateVerified = (await check( () => this.messageDuplicateDeleteGuard!.assertIntentStillActionable(params), duplicateReceipts.map((receipt) => receipt.reasonKey), )) === \u0027allowed\u0027;");
    const guardedReasons = boundary.includes("await this.authorizeGuardedUserDeleteReasons(") &&
      reasons.includes("ownedReasonsOnly: true") && reasons.includes("if (!reasons.length)") &&
      (preparedReasons ? preparedQualification : legacyQualification) &&
      boundary.includes("messageDuplicateVerified = proof.messageDuplicateVerified;") &&
      returnsDuplicateQualification(reasons) && returnsDuplicateQualification(boundary);
    const permit = method(guard, "private async assertAuthorization(");
    const qualification = method(guard, "async assertQualificationAuthority(");
    const imageEvidence = squash(topLevelFunction(state, "export function hasValidImageComparisonEvidence("));
    const imageSettings = topLevelFunction(state, "export function exactImageSettingsDigest(");
    const imageHistory = classMethod(history, "async observeWithOutcome(");
    const imageHistoryRevision = method(history, "private hasCurrentRevision(");
    const imageOriginal = squash(method(media, "private async findRecompression("));
    const imageDownload = squash(classMethod(photoAnalysis, "async verifyRecompression("));
    const imageNativeCall = squash(classMethod(photoFingerprint, "async verifyRecompression(")).replace(/\s+(?=\.)/gu, "");
    const imageNative = squash(topLevelFunction(photoRecompression, "export async function verifyNativePhotoRecompression("));
    const imageResidual = squash(topLevelFunction(photoRecompression, "function residualWithinBounds("));
    const imageIndexRead = classMethod(recompressionIndex, "async read(");
    const imageIndexRemember = classMethod(recompressionIndex, "async remember(");
    const imageIndexLua = recompressionIndex.match(/export const DUPLICATE_RECOMPRESSION_INDEX_SCRIPT = `([\s\S]*?)`;/u)?.[1] ?? "";
    const imageIndexCommand = classMethod(counters, "async duplicateRecompressionIndex(");
    const imageObserveStart = window.indexOf("if p.op ~= \u0027observe\u0027 then");
    const imagePinStart = window.indexOf("if p.recompressionOriginal then", imageObserveStart);
    const imageObserveBoundary = window.indexOf("local previous = read(stateKey(p.member))", imageObserveStart);
    const imageAtomicOriginal = squash(window.slice(imagePinStart, imageObserveBoundary));
    const imagePinBeforeMutations = imageObserveStart >= 0 && imagePinStart > imageObserveStart &&
      imageObserveBoundary > imagePinStart &&
      !/\bwrite\s*\(|redis\.call\s*\(/u.test(window.slice(imageObserveStart, imagePinStart)) &&
      imageAtomicOriginal.includes("local expected = p.recompressionOriginal") &&
      imageAtomicOriginal.includes("if p.mode ~= \u0027IMAGE\u0027 or #p.fingerprints ~= 1 then return cjson.encode({ kind = \u0027stale\u0027 }) end") &&
      imageAtomicOriginal.includes("local original = read(groupKey(p.fingerprints[1]))") &&
      imageAtomicOriginal.includes("if not valid(original) or original.member ~= expected.member") &&
      imageAtomicOriginal.includes("original.revision ~= expected.revision") &&
      imageAtomicOriginal.includes("original.originalId ~= expected.originalId") &&
      imageAtomicOriginal.includes("original.epoch ~= expected.epoch") &&
      imageAtomicOriginal.includes("original.contentDigest ~= expected.contentDigest") &&
      imageAtomicOriginal.includes("p.at < original.publishedAtMs") &&
      imageAtomicOriginal.includes("p.at >= original.expiresAtMs") &&
      imageAtomicOriginal.includes("or (p.periodStart and original.publishedAtMs < p.periodStart) then return cjson.encode({ kind = \u0027stale\u0027 }) end end");
    const recompressionReader =
      recompressionVersion.includes("PHOTO_RECOMPRESSION_VERSION = \u0027native-recompression-v1\u0027") &&
      state.includes(".refine(hasValidImageComparisonEvidence)") &&
      permit.includes("!hasValidImageComparisonEvidence(binding)") &&
      imageHistoryRevision.includes("hasValidImageComparisonEvidence(binding)") &&
      imageEvidence.includes("if (value.compareMode !== \u0027IMAGE\u0027) return proof === undefined;") &&
      imageEvidence.includes("if (equal) return proof === undefined;") &&
      imageEvidence.includes("proof.version === PHOTO_RECOMPRESSION_VERSION") &&
      imageEvidence.includes("original.length === 1") && imageEvidence.includes("value.mediaHashes.length === 1") &&
      imageEvidence.includes("proof.originalHash === original[0]") &&
      imageEvidence.includes("proof.currentHash === value.mediaHashes[0]") &&
      imageSettings.includes("version: \u0027image-recompression-fixed-window-v1\u0027") &&
      imageHistory.includes("const anchorIdentity = recompression") &&
      imageHistory.includes("[recompression.originalHash]") &&
      imageHistory.includes("recompression.currentHash !== mediaHashes[0]") &&
      history.includes("imageOriginal?: MessageDuplicateOriginal;") &&
      imageHistory.includes("!input.imageOriginal ||") &&
      imageHistory.includes("input.imageOriginal.mediaHashes.length !== 1") &&
      imageHistory.includes("input.imageOriginal.mediaHashes[0] !== recompression.originalHash") &&
      imageHistory.includes("recompressionOriginal: input.imageOriginal") && imagePinBeforeMutations &&
      imageHistory.includes("if (!hasValidImageComparisonEvidence(binding))") &&
      squash(media).includes("const anchor = parsed.data.recompressionAnchor ?? parsed.data;") &&
      /if\s*\(\s*imageOnly && verified\.hashes\.length === 1 && verified\.recompressionHash && !recompression\.anchor\s*\)\s*await this\.rememberRecompression\(/u.test(squash(media)) &&
      imageOriginal.includes("const baseline = await this.loadSource(candidate.webhookEventId);") &&
      imageOriginal.includes("!isExactImageContent(content) || content.media.length !== 1") &&
      imageOriginal.includes("message.messageId !== candidate.messageId") &&
      imageOriginal.includes("candidate.expiresAtMs <= input.job.eventTimestampMs") &&
      imageOriginal.includes("result = await this.photos.verifyRecompression({") &&
      imageOriginal.includes("expectedOriginalHash: candidate.canonicalHash") &&
      imageOriginal.includes("expectedCurrentHash: input.verified.hashes[0]!") &&
      imageOriginal.includes("const original = await this.history.observeWithOutcome(originalInput)") &&
      imageOriginal.includes("await this.history.findImageOriginal({") &&
      imageOriginal.includes("accepted?.mediaHashes.length !== 1") &&
      imageOriginal.includes("accepted.mediaHashes[0] !== candidate.canonicalHash") &&
      imageOriginal.includes("mediaHashes: [candidate.canonicalHash]") &&
      imageOriginal.includes("original.outcome === \u0027STALE\u0027") &&
      imageDownload.includes("const original = await this.downloader.download(params.originalUrl,") &&
      imageDownload.includes("const current = await this.downloader.download(params.currentUrl,") &&
      imageDownload.includes("result.proof.originalHash !== params.expectedOriginalHash") &&
      imageDownload.includes("result.proof.currentHash !== params.expectedCurrentHash") &&
      imageNativeCall.includes("await this.nativeDecoder.verifyRecompression(original, current, request)") &&
      imageNative.includes("a.info.width !== b.info.width") && imageNative.includes("a.info.height !== b.info.height") &&
      imageNative.includes("originalHash: canonicalHash(a.data, a.info.width, a.info.height)") &&
      imageNative.includes("currentHash: canonicalHash(b.data, b.info.width, b.info.height)") &&
      /residualWithinBounds\(\s*blurredA, blurredB/u.test(imageNative) &&
      /residualWithinBounds\(\s*colorA, colorB/u.test(imageNative) &&
      imageResidual.includes("Math.abs(difference) > limits.maximum") &&
      imageResidual.includes("square > count * limits.tileRms ** 2") &&
      imageIndexRead.includes("await this.redis.duplicateRecompressionIndex(") &&
      imageIndexRemember.includes("await this.redis.duplicateRecompressionIndex(") &&
      imageIndexLua.includes("redis.call(\u0027TIME\u0027)") &&
      imageIndexLua.includes("for i=1,8 do") && /#decoded\s*>\s*8\b/u.test(imageIndexLua) &&
      imageIndexLua.includes("math.min(expires,r.expiresAtMs)") &&
      imageIndexLua.includes("r.expiresAtMs>p.atMs") &&
      imageIndexLua.includes("for i=1,16,2 do") &&
      imageIndexLua.includes("if distance>6 then return false end") &&
      imageIndexLua.includes("p.op~=\u0027read\u0027 or withinHamming(r.recompressionHash)") &&
      imageIndexLua.indexOf("withinHamming(r.recompressionHash)") < imageIndexLua.indexOf("for i=1,math.min(8,#all) do") &&
      imageIndexLua.includes("redis.call(\u0027SET\u0027,KEYS[i],encoded[i],\u0027PXAT\u0027,deadlines[i])") &&
      imageIndexCommand.includes("DUPLICATE_RECOMPRESSION_INDEX_SCRIPT,");
    const near = method(detector, "private buildNearDuplicateFingerprint(");
    const fingerprints = method(detector, "\n  buildFingerprints(");
    const detectorTextNormalization = topLevelFunction(detector, "function normalizeDuplicateText(");
    const contentTextNormalization = topLevelFunction(content, "export function normalizeMessageDuplicateText(");
    const semanticTextNormalization = topLevelFunction(semantic, "export function normalizeDuplicateSemanticText(");
    const protectedUnit = topLevelFunction(semantic, "function protectedQuantityUnit(");
    const finiteUnit = topLevelFunction(semantic, "function isQuantityUnit(");
    const unitSuffix = topLevelFunction(semantic, "export function hasDuplicateQuantityUnitSuffix(");
    const unitPrefix = topLevelFunction(semantic, "export function hasDuplicateQuantityUnitPrefix(");
    const prefixUnitSpans = squash(topLevelFunction(semantic, "function prefixQuantityUnitSpans("));
    const mergeUnitSpans = squash(topLevelFunction(semantic, "function mergeQuantityUnitSpans("));
    const finiteUnitSymbols = (name) => {
      const body = semantic.match(new RegExp("const " + name + "\\s*=\\s*\\[([\\s\\S]*?)\\];", "u"))?.[1] ?? "";
      return new Set(Array.from(squash(body).matchAll(/\u0027([^\u0027\r\n]+)\u0027/gu), (match) => match[1]));
    };
    const latinUnitSymbols = finiteUnitSymbols("SI_SYMBOLS");
    const cyrillicUnitSymbols = finiteUnitSymbols("CYRILLIC_SYMBOLS");
    const quantityUnitToken = semantic.match(/const QUANTITY_UNIT_TOKEN\s*=\s*(\/[^\r\n]+\/gu);/u)?.[1];
    const quantityCompoundComponent = semantic.match(/const QUANTITY_COMPOUND_COMPONENT\s*=\s*(\/[^\r\n]+\/uy);/u)?.[1];
    const quantityPrefixSeparator = semantic.match(/const QUANTITY_PREFIX_SEPARATOR\s*=\s*(\/[^\r\n]+\/uy);/u)?.[1];
    const quantityScalar = semanticTextNormalization.match(/const quantities\s*=\s*(\/[^\r\n]+\/gu);/u)?.[1];
    const authorityStart = guard.indexOf("if (params.authorityOnly)");
    const authorityEnd = guard.indexOf("return this.assertMessageStillActionable", authorityStart);
    const authority = guard.slice(authorityStart, authorityEnd);
    const mutationStart = executor.search(/const beforeImmediateDeleteMutation = async \(\s*(?:beforeFinalAuthority\?: \(\) => Promise<void>,?\s*)?\) => \{/u);
    const mutationEnd = executor.indexOf("\n          };", mutationStart);
    const mutation = stripComments(executor.slice(mutationStart, mutationEnd));
    const suggestionProof = mutation.lastIndexOf("await this.suggestionSubscriptions!.assertDeletionAllowed(suggestionProof)");
    const finalPermit = mutation.lastIndexOf("await this.messageDuplicateDeleteGuard.assertIntentStillActionable(");
    const markedMutation = /const beforeImmediateDeleteMutation = async \(\s*beforeFinalAuthority\?:/u.test(mutation);
    const transportCheckpoint = mutation.indexOf("await beforeFinalAuthority?.()");
    const finalDeadlineFence = mutation.indexOf("let verifiedReasonAuthorityAtMs = await this.assertVerifiedReasonDeadlineFence(");
    const composedDispatch = squash(mutation).includes("let textProof = await this.runDeletePreDispatchGuards( intent, botId, options, leaseToken, \u0027dispatch\u0027, async () => { try { await beforeFinalAuthority?.();");
    // FLAG: Prepared MAX evidence precedes the sole nested transport checkpoint;
    // the final suggestion/deadline/duplicate permit still follow that reservation.
    const preparedCheckpoint = preparedQualification && composedDispatch &&
      transportCheckpoint >= 0 && transportCheckpoint < suggestionProof &&
      count(mutation, "await beforeFinalAuthority?.()") === 1 &&
      squash(boundary).includes("const proof = await this.authorizeGuardedUserDeleteReasons( intent, botId, finalDispatchLeaseToken, async () => { await beforeFinalAuthority?.();") &&
      mutation.includes("textProof = await finalizeDeleteAuthority(textProof.independentRecheck);") &&
      count(mutation, "await this.assertVerifiedReasonDeadlineFence(") === 2;
    const phoneContext = phones.match(/const PHONE_CONTEXT\s*=\s*(\/[^\r\n]+\/iu);/u)?.[1];
    const phoneNumberContext = phones.match(/const PHONE_NUMBER_CONTEXT\s*=\s*(\/[^\r\n]+\/iu);/u)?.[1];
    const quantitySuffix = phones.match(/const QUANTITY_SUFFIX\s*=\s*(\/[^\r\n]+\/iu);/u)?.[1] ?? "";
    const phoneEvidence = topLevelFunction(phones, "function phoneEvidence(");
    const phoneEvidenceCode = squash(phoneEvidence).replace(/\s+(?=\?\.|\.)/gu, "");
    const unprefixedConfidence = phoneEvidenceCode.indexOf("if (!international && !knownLength) return null;");
    const labelAdmission = phoneEvidenceCode.indexOf("const labelled = PHONE_CONTEXT.test(before) || hasLabelledPhoneListPredecessor(before);");
    const conventionalInternationalPhone = topLevelFunction(phones, "function hasConventionalInternationalPhoneFormat(");
    const phoneListContinuation = topLevelFunction(phones, "function hasLabelledPhoneListContinuation(");
    const phoneListPredecessor = topLevelFunction(phones, "function hasLabelledPhoneListPredecessor(");
    const adjacency = topLevelFunction(phones, "function hasEmbeddedIdentifierAdjacency(");
    const protectedValue = topLevelFunction(phones, "function hasProtectedValueContext(");
    const phoneExtraction = topLevelFunction(phones, "export function analyzeDuplicatePhoneNumbers(");
    const phoneStripping = topLevelFunction(phones, "export function stripAnalyzedDuplicatePhoneNumbers(");
    const rawAdjacencyCheck = phoneEvidence.indexOf("if (hasEmbeddedIdentifierAdjacency(before, after, afterTruncated)) return null;");
    const beforeNormalization = phoneEvidence.indexOf("before = before.replace(");
    const afterNormalization = phoneEvidence.indexOf("after = after.replace(");
    const protocolWrappers = adjacency.match(/const protocolBefore = before\.replace\(\/([^\r\n]+)\/u,/u)?.[1];
    const leftWrappers = adjacency.match(/const left = before\.replace\(\/([^\r\n]+)\/u,/u)?.[1];
    const rightWrappers = adjacency.match(/const right = after\.replace\(\/([^\r\n]+)\/u,/u)?.[1];
    const arithmeticWrappers = adjacency.match(/const arithmeticBefore = arithmeticContext\.replace\(\/([^\r\n]+)\/u,/u)?.[1];
    const arithmeticCondition = squash(adjacency).match(/if\s*\(\s*!PHONE_CONTEXT\.test\(arithmeticBefore\) &&([\s\S]*?)\)\s*return true;/u)?.[1]?.trim();
    const identifierContext = phones.match(/const IDENTIFIER_CONTEXT\s*=\s*(\/[^\r\n]+\/iu);/u)?.[1] ?? "";
    const protectedLabelContext = phones.match(/const PROTECTED_LABEL_IN_CLAUSE\s*=\s*(\/[^\r\n]+\/iu);/u)?.[1] ?? "";
    const technicalIdentifierForms = "модел(?:ь|и|ью|ей|ям|ями|ях)|сертификат(?:а|у|ом|е|ы|ов|ам|ами|ах)?|штрих[- ]?код(?:а|у|ом|е|ы|ов|ам|ами|ах)?|model|certificate|barcode|imei|ean|gtin";
    const identifierForms = "номер(?:а|у|ом|е|ов|ам|ами|ах)?|код(?:а|у|ом|е|ы|ов|ам|ами|ах)?|идентификатор(?:а|у|ом|е|ы|ов|ам|ами|ах)?|артикул(?:а|у|ом|е|ы|ов|ам|ами|ах)?|" + technicalIdentifierForms + "|инн";
    const urlExcludedBeforeEvidence = () => {
      const ranges = phoneExtraction.indexOf("const urlRanges = getUrlTextRanges(text);");
      const exclusion = phoneExtraction.indexOf("if (urlIndex < urlRanges.length && urlRanges[urlIndex]!.start < end) continue;");
      const evidence = phoneExtraction.indexOf("const phone = phoneEvidence(");
      return ranges >= 0 && exclusion > ranges && evidence > exclusion;
    };
    const valid = recompressionReader && start >= 0 && end > start &&
      guard.includes("class MessageDuplicateDeleteGuardService") &&
      check.includes("await this.history.stillMatches(") &&
      check.includes("message_duplicate_content_changed") &&
      count(check, "await this.assertAuthorization(params.chatId, binding)") >= 2 &&
      /await this\.assertAuthorization\(params\.chatId, binding\); if \(notice && Date\.now\(\) >= notice\.deadlineAtMs\) throw new MessageDuplicateGuardRejectedError\(.message_duplicate_notice_expired.\); if \(Date\.now\(\) >= Math\.min\(binding\.authorization!\.deadlineAtMs, binding\.original\.expiresAtMs\)\) throw new MessageDuplicateGuardRejectedError\(.message_duplicate_action_expired.\); return .allowed./u.test(squash(check)) &&
      permit.includes("binding.version !== 3") &&
      permit.includes("binding.lifecycleRevision") &&
      permit.includes("binding.original?.revision") &&
      permit.includes("binding.authorization") &&
      permit.includes("await this.authorization.isAllowed(chatId, binding)") &&
      qualification.includes("await this.assertAuthorization(chatId, binding)") &&
      guard.includes("settings.duplicatePolicyRevision !== binding.policyRevision") &&
      state.includes("z.literal(3)") &&
      state.includes("lifecycleRevision:") &&
      state.includes("authorization:") &&
      state.includes("messageDuplicateEnforcementScope") &&
      state.includes("text-fixed-window-safe-text-v14") &&
      state.includes("text-fixed-window-v14") &&
      state.includes("const safeTextMatchingEnabled = nearEnabled || phoneValueMatchingEnabled;") &&
      /const phoneValueMatchingEnabled\s*=\s*settings.duplicateDetectionPreset === .CUSTOM. && settings.duplicateIgnorePhonesEnabled/u.test(state) &&
      /version:\s*safeTextMatchingEnabled\s*\?/u.test(state) &&
      near.includes("/[\\p{L}\\p{N}][\\p{L}\\p{M}\\p{N}]*/gu") &&
      near.includes("const gap = normalized.slice(end, until);") &&
      near.includes("if (!/\\S/u.test(gap)) return;") &&
      near.includes("/[^\\p{P}\\p{Z}\\s]/u.test(gap) ? gap : gap.replace(/\\s+/gu, ") &&
      near.includes("protectedGaps.push([beforeToken, protectedGap])") &&
      near.includes("JSON.stringify({ version: 3, tokens, numericTokens, protectedGaps })") &&
      detector.includes("from \u0027./duplicate-phone-evidence\u0027") &&
      fingerprints.includes("analyzeDuplicatePhoneNumbers(rawText)") &&
      fingerprints.includes("stripAnalyzedDuplicatePhoneNumbers(rawText, phoneAnalysis, config)") &&
      squash(fingerprints).includes("config.ignorePhones || config.ignoreLinks || config.matchPhoneValues") &&
      fingerprints.includes("const content = normalizeDuplicateText(approximateSource);") &&
      near.includes("const numericTokens = approximateSource.match(/[+-]?\\d+(?:[.,:]\\d+)*/gu) ?? [];") &&
      detector.includes(".update(\u0027text-v14\\0\u0027)") &&
      detector.includes("import { normalizeDuplicateSemanticText } from \u0027./duplicate-semantic-text\u0027;") &&
      content.includes("import { normalizeDuplicateSemanticText } from \u0027../duplicate-semantic-text\u0027;") &&
      detectorTextNormalization.includes("return normalizeDuplicateSemanticText(value);") &&
      contentTextNormalization.includes("return normalizeDuplicateSemanticText(value);") &&
      semanticTextNormalization.includes("const source = value.normalize(\u0027NFC\u0027);") &&
      semantic.includes("const QUANTITY_UNITS = new Set(") &&
      ["Wh", "Ah", "VA", "var"].every((unit) => latinUnitSymbols.has(unit)) &&
      ["Втч", "Ач", "ВА", "вар", "ч"].every((unit) => cyrillicUnitSymbols.has(unit)) &&
      semantic.includes("...SI_PREFIXES.flatMap((prefix) => SI_SYMBOLS.map((symbol) => prefix + symbol))") &&
      semantic.includes("...CYRILLIC_PREFIXES.flatMap((prefix) => CYRILLIC_SYMBOLS.map((symbol) => prefix + symbol))") &&
      squash(protectedUnit).includes("const wordUnit = /^(.*?)(bytes?|bits?)$/iu.exec(unit); return wordUnit ? wordUnit[1]! + wordUnit[2]!.toLowerCase() : unit;") &&
      squash(finiteUnit).includes("return QUANTITY_UNITS.has(unit.replace(/\\p{Cf}/gu, \u0027\u0027).toLowerCase());") &&
      unitSuffix.includes("value.normalize(\u0027NFC\u0027)") &&
      unitSuffix.includes("return unit !== undefined && isQuantityUnit(unit);") &&
      squash(unitPrefix).includes("return prefixQuantityUnitSpans(value.normalize(\u0027NFC\u0027), true).length > 0;") &&
      quantityUnitToken === "/(?<![\\p{L}\\p{M}\\p{N}_])([\\p{L}\\p{M}\\p{Cf}]+)(?=[²³⁻⁰¹⁴⁵⁶⁷⁸⁹]|$|[^\\p{L}\\p{M}\\p{N}_])/gu" &&
      quantityCompoundComponent === "/(?:\\^[+-]?\\p{N}+|[²³⁻⁺⁰¹⁴⁵⁶⁷⁸⁹]+)?(?:[\\s\\p{Cf})\\]}»\"\u0027\u201d\u2019]*[/·⋅∙*×÷∕⁄][\\s\\p{Cf}([{«\"\u0027\u201c\u2018]*|[\\p{Cf})\\]}»\"\u0027\u201d\u2019]*\\s[\\s\\p{Cf}()[\\]{}«»\"\u0027\u201c\u2018\u201d\u2019]*)([\\p{L}\\p{M}\\p{Cf}]+)(?![\\p{L}\\p{M}_])/uy" &&
      quantityPrefixSeparator === "/(?:[\\s\\p{Cf}()[\\]{}«»\"\u0027\u201c\u2018\u201d\u2019]*(?:[:=—–])[\\s\\p{Cf}()[\\]{}«»\"\u0027\u201c\u2018\u201d\u2019]*|[\\s\\p{Cf}()[\\]{}«»\"\u0027\u201c\u2018\u201d\u2019]+-[\\s\\p{Cf}()[\\]{}«»\"\u0027\u201c\u2018\u201d\u2019]+|[\\s\\p{Cf}()[\\]{}«»\"\u0027\u201c\u2018\u201d\u2019]+)/uy" &&
      quantityScalar === "/(?:(?<![\\p{L}\\p{M}\\p{N}_])|(?<=\\p{N}[xXхХ]))[+-]?\\p{N}+(?:[.,]\\p{N}+)?(?:[eE][+-]?\\p{N}+)?[\\s\\p{Cf}()[\\]{}«»\"\u0027\u201c\u2018\u201d\u2019·⋅∙*/×÷∕⁄:=—–-]*([\\p{L}\\p{M}\\p{Cf}]+)(?![\\p{L}\\p{M}_])/gu" &&
      prefixUnitSpans.includes("const tokens = new RegExp(QUANTITY_UNIT_TOKEN); const compound = new RegExp(QUANTITY_COMPOUND_COMPONENT); const separator = new RegExp(QUANTITY_PREFIX_SEPARATOR);") &&
      prefixUnitSpans.includes("const scalar = /[+-]?\\p{N}+(?:[.,]\\p{N}+)?(?:[eE][+-]?\\p{N}+)?/uy;") &&
      prefixUnitSpans.includes("const exponent = /(?:\\^[+-]?\\p{N}+|[²³⁻⁺⁰¹⁴⁵⁶⁷⁸⁹]+)/uy;") &&
      prefixUnitSpans.includes("while ((token = tokens.exec(source)) !== null) { if (!isQuantityUnit(token[1]!)) continue;") &&
      prefixUnitSpans.includes("compound.lastIndex = end; const next = compound.exec(source); if (!next || !isQuantityUnit(next[1]!)) break;") &&
      prefixUnitSpans.includes("exponent.lastIndex = end; if (exponent.exec(source)) end = exponent.lastIndex;") &&
      prefixUnitSpans.includes("tokens.lastIndex = end; separator.lastIndex = end; if (!separator.exec(source)) continue;") &&
      prefixUnitSpans.includes("if (valueFollows) { if (separator.lastIndex === source.length) return expressionSpans; } else { scalar.lastIndex = separator.lastIndex; if (scalar.exec(source)) for (const span of expressionSpans) spans.push(span); }") &&
      mergeUnitSpans.includes("while (suffixIndex < suffix.length || prefixIndex < prefix.length)") &&
      mergeUnitSpans.includes("prefixIndex >= prefix.length || (suffixIndex < suffix.length && suffix[suffixIndex]![0] <= prefix[prefixIndex]![0]) ? suffix[suffixIndex++]! : prefix[prefixIndex++]!;") &&
      mergeUnitSpans.includes("if (spans.at(-1)?.[0] === next[0]) continue; spans.push(next);") &&
      semanticTextNormalization.includes("while ((quantity = quantities.exec(source)) !== null)") &&
      semanticTextNormalization.includes("if (!isQuantityUnit(unit)) continue;") &&
      semanticTextNormalization.includes("compound.lastIndex = end;") &&
      semanticTextNormalization.includes("if (!next || !isQuantityUnit(next[1]!)) break;") &&
      semanticTextNormalization.includes("quantities.lastIndex = end;") &&
      squash(semanticTextNormalization).includes("const spans = mergeQuantityUnitSpans(suffixSpans, prefixQuantityUnitSpans(source, false));") &&
      semanticTextNormalization.includes("protectedQuantityUnit(source.slice(from, end))") &&
      semanticTextNormalization.includes("parts.push(source.slice(cursor).toLowerCase());") &&
      phones.includes("from \u0027./duplicate-semantic-text\u0027;") &&
      protectedValue.includes("hasDuplicateQuantityUnitSuffix(after)") &&
      /DUPLICATE_PHONE_EVIDENCE_VERSION\s*=\s*8\b/u.test(phones) &&
      phoneContext === "/(?:^|[^\\p{L}\\p{N}_])(?:тел|телефон(?:а|у|ом|е|ы|ов|ам|ами|ах)?|звоните|позвоните|звони|позвони|звонить|позвонить|связаться|свяжитесь|whatsapp|ватсап|viber|вайбер|phone|telephone|call)\\s*(?:для\\s+связи\\s*)?[:=№#.-]?\\s*$/iu" &&
      phoneNumberContext === "/(?:^|[^\\p{L}\\p{N}_])номер(?:а|у|ом|е|ов|ам|ами|ах)?\\s+телефон(?:а|у|ом|е|ы|ов|ам|ами|ах)?\\s*(?:для\\s+связи\\s*)?[:=№#.-]?\\s*$/iu" &&
      phones.includes("import { getUrlTextRanges } from \u0027../common/url-text.util\u0027;") &&
      rawAdjacencyCheck >= 0 && beforeNormalization > rawAdjacencyCheck && afterNormalization > rawAdjacencyCheck &&
      squash(phoneEvidence).includes("before = before.replace(/\\p{Cf}/gu, \u0027\u0027).replace(") &&
      squash(phoneEvidence).includes("after = after.replace(/\\p{Cf}/gu, \u0027\u0027).replace(") &&
      protocolWrappers === "[\\p{Cf}()[\\]{}«»\"\u0027\u201c\u2018\u201d\u2019]+$" &&
      leftWrappers === "[^\\s\\p{L}\\p{M}\\p{N}_]+$" &&
      rightWrappers === "^[^\\s\\p{L}\\p{M}\\p{N}_]+" &&
      adjacency.includes("/(?:^|[^\\p{L}\\p{N}_])(?:tel|mailto|sms|callto|sips?):$/iu.test(protocolBefore)") &&
      /test\(protocolBefore\)\)\s*return true;/u.test(adjacency) &&
      adjacency.includes("if (/@[^\\s]*$/u.test(before) || /^[^\\s]*@/u.test(after)) return true;") &&
      squash(adjacency).includes("const arithmeticContext = before.replace(/\\p{Cf}/gu, \u0027\u0027); const arithmeticBefore = arithmeticContext.replace(") &&
      arithmeticWrappers === "[\\s([{«\"\u0027\u201c\u2018]+$" &&
      squash(adjacency).includes("if (/\\p{Sc}$/u.test(arithmeticBefore)) return true;") &&
      squash(adjacency).includes("if ( /^[\\s\\p{Cf})\\]}»\"\u0027\u201d\u2019]*[\\p{Sm}*/%^·\\u2010-\\u2013-]+[\\s\\p{Cf}]*[\\p{L}\\p{M}\\p{N}_]/u.test(after) && !hasLabelledPhoneListContinuation(arithmeticBefore, after, afterTruncated) ) return true;") &&
      arithmeticCondition === "(/[\\p{Sm}*/%^·\\u2010-\\u2013-]$/u.test(arithmeticBefore) || /(?:^|\\s)(?:\\p{L}\\p{M}*|\\p{N}{1,6}|_)\\s+$/u.test(arithmeticContext))" &&
      squash(adjacency).includes("if ( /(?:^|\\s)[+-]?\\d(?:[\\d \\t().-]*\\d)?\\s+$/u.test(arithmeticContext) && !hasLabelledPhoneListPredecessor(arithmeticContext) ) return true;") &&
      squash(phoneListContinuation).includes("if (!PHONE_CONTEXT.test(before)) return false; const next = after.matchAll(CANDIDATE).next().value; if (!next) return false; const candidate = next[1]!; const start = next.index + next[0].length - candidate.length;") &&
      squash(phoneListContinuation).includes("return ( candidate.startsWith(\u0027+\u0027) && /^[\\s\\p{Cf})\\]}»\"\u0027\u201d\u2019]*$/u.test(after.slice(0, start)) && phoneEvidence(candidate, before, after.slice(start + candidate.length), afterTruncated) !== null );") &&
      squash(phoneListPredecessor).includes("const previous = [...before.matchAll(CANDIDATE)].at(-1); if (!previous) return false; const candidate = previous[1]!; const start = previous.index + previous[0].length - candidate.length; const prefix = before.slice(0, start);") &&
      squash(phoneListPredecessor).includes("return ( PHONE_CONTEXT.test(prefix.replace(/[\\s([{«\"\u0027\u201c\u2018]+$/u, \u0027 \u0027)) && /^\\s*$/u.test(before.slice(start + candidate.length)) && phoneEvidence(candidate, prefix, \u0027\u0027) !== null );") &&
      identifierContext.includes(identifierForms) && protectedLabelContext.includes(identifierForms) &&
      squash(protectedValue).includes("const phoneNumberLabel = PHONE_NUMBER_CONTEXT.test(before); const phoneLabel = PHONE_CONTEXT.exec(before); const protectedClause = clause.replace(PHONE_NUMBER_CONTEXT, \u0027 \u0027);") &&
      squash(protectedValue).includes("return ( QUANTITY_PREFIX.test(before) || QUANTITY_SUFFIX.test(after) || hasDuplicateQuantityUnitSuffix(after) || hasDuplicateQuantityUnitPrefix(before) || (phoneLabel !== null && hasDuplicateQuantityUnitPrefix(before.slice(0, phoneLabel.index))) || (IDENTIFIER_CONTEXT.test(before) && !phoneNumberLabel) || PROTECTED_LABEL_IN_CLAUSE.test(protectedClause) );") &&
      quantitySuffix.includes("\\p{Sc}") && quantitySuffix.includes("тыс\\.?") &&
      quantitySuffix.includes("участник\\p{L}*") && quantitySuffix.includes("[kmgt]i?(?:b|bps|bits?)") &&
      adjacency.includes("const label = PHONE_CONTEXT.exec(left);") &&
      /const labelled\s*=\s*label !== null &&/u.test(adjacency) &&
      adjacency.includes("(label.index === 0 || /^\\s/u.test(label[0]) || /\\s$/u.test(left.slice(0, label.index)))") &&
      adjacency.includes("(/[\\p{L}\\p{M}\\p{N}_]$/u.test(left) && !labelled) ||") &&
      adjacency.includes("/^[\\p{L}\\p{M}\\p{N}_]/u.test(right)") &&
      urlExcludedBeforeEvidence() &&
      phoneExtraction.includes("while (urlIndex < urlRanges.length && urlRanges[urlIndex]!.end <= start) urlIndex += 1;") &&
      phoneExtraction.includes("if (beforeStart > 0 && !CONTEXT_CLAUSE_BOUNDARY.test(before)) continue;") &&
      phoneExtraction.includes("end + 64 < text.length") &&
      phoneEvidence.includes("if (afterTruncated && UNFINISHED_RIGHT_CONTEXT.test(after)) return null;") &&
      adjacency.includes("const colon = /^[\\s\\p{Cf})\\]}»\"\u0027\u201d\u2019]*:[\\s\\p{Cf}]*/u.exec(after);") &&
      adjacency.includes("QUANTITY_SUFFIX.test(value) ||") &&
      adjacency.includes("hasDuplicateQuantityUnitSuffix(value) ||") &&
      adjacency.includes("(afterTruncated && !/[\\s.!?;,\\n\\r\\u2028\\u2029]/u.test(value))") &&
      phoneStripping.includes("options.ignorePhones ? analysis.phoneRanges : []") &&
      phoneStripping.includes("options.ignoreLinks ? analysis.urlRanges : []") &&
      phoneStripping.includes("parts.push(text.slice(cursor, range.start), \u0027 \u0027)") &&
      squash(phoneEvidence).includes("if (digits.length < 10 || digits.length > 15 || hasProtectedValueContext(before, after)) return null;") &&
      phoneEvidence.includes("const international = candidate.startsWith(\u0027+\u0027) && /^[1-9]\\d{9,14}$/u.test(digits);") &&
      phoneEvidence.includes("if (/^[17]/u.test(digits) && digits.length !== 11) return null;") &&
      phoneEvidence.includes("if (!international && digits.startsWith(\u00278\u0027) && digits.length !== 11) return null;") &&
      phoneEvidence.includes("if (!international && digits.startsWith(\u00279\u0027) && digits.length !== 10) return null;") &&
      squash(phoneEvidence).includes("const knownLength = (/^[17]/u.test(digits) && digits.length === 11) || (!international && digits.startsWith(\u00278\u0027) && digits.length === 11) || (!international && digits.startsWith(\u00279\u0027) && digits.length === 10); if (!international && !knownLength) return null;") &&
      squash(phoneEvidence).includes("if (!knownLength && /[^\\d+]/u.test(candidate)) return null;") &&
      unprefixedConfidence >= 0 && labelAdmission > unprefixedConfidence &&
      phoneEvidenceCode.includes("if (candidate.includes(\u0027.\u0027)) { const groups = candidate.match(/\\d+/gu)?.map((group) => group.length).join(\u0027/\u0027); const conventionalGroups = (digits.length === 11 && [\u00271/3/3/2/2\u0027, \u00271/3/3/4\u0027].includes(groups ?? \u0027\u0027)) || (digits.length === 10 && groups === \u00273/3/2/2\u0027); if (!knownLength || !conventionalGroups) return null; }") &&
      phoneEvidenceCode.includes("const labelled = PHONE_CONTEXT.test(before) || hasLabelledPhoneListPredecessor(before);") &&
      phoneEvidenceCode.includes("if (!labelled && !hasConventionalInternationalPhoneFormat(candidate)) return null;") &&
      squash(conventionalInternationalPhone).includes("return /^\\+[17](?:\\s*\\(\\d{3}\\)\\s*\\d{3}(?:-\\d{2}-\\d{2}|-\\d{4})|[ .-]\\d{3}[ .-]\\d{3}(?:[ .-]\\d{2}[ .-]\\d{2}|[ .-]\\d{4}))$/u.test( candidate, );") &&
      phones.includes("\\.(?![ \\t\\u00a0\\u202f])") &&
      state.includes("import { MESSAGE_DUPLICATE_HISTORY_STORAGE_VERSION } from \u0027./message-duplicate-window.script\u0027;") &&
      count(state, "historyStorageVersion: MESSAGE_DUPLICATE_HISTORY_STORAGE_VERSION") === 2 &&
      window.includes("MESSAGE_DUPLICATE_HISTORY_STORAGE_VERSION = \u0027v4\u0027") &&
      window.includes("MESSAGE_DUPLICATE_HISTORY_FENCE_STORAGE_VERSION = \u0027v3\u0027") &&
      window.includes("local resetPrefix = KEYS[1] .. \u0027${MESSAGE_DUPLICATE_HISTORY_FENCE_STORAGE_VERSION}:\u0027") &&
      count(window, "local namespace = string.sub(key, 1, 8) == \u0027removed:\u0027 and resetPrefix or prefix") === 2 &&
      window.includes("local raw = redis.call(\u0027GET\u0027, namespace .. key)") &&
      window.includes("redis.call(\u0027SET\u0027, namespace .. key, cjson.encode(value), \u0027PXAT\u0027, expiry)") &&
      window.includes("if (not previousLife or not previousLife.materializedRevision) and currentEpoch ~= 0 then") &&
      window.includes("local raw = redis.call(\u0027GET\u0027, resetPrefix .. \u0027life:\u0027 .. p.member .. \u0027:\u0027 .. p.mode)") &&
      window.includes("local materialized = previousLife and previousLife.materialized or (priorLife and priorLife.materialized or nil)") &&
      window.includes("if life.source == materialized.source or priorLife then life.introducedAt = p.at end") &&
      count(window, "local raw = redis.call(\u0027GET\u0027, resetPrefix .. key)") === 2 &&
      window.includes("if at < prior.at or (at == prior.at and (prior.conflict or prior.source ~= source)) then return nil end") &&
      squash(window).includes("if prior.source ~= source then publishedAt = at elseif prior.introducedKnown == false then") &&
      window.includes("revision = p.token, introducedAt = 0, introducedKnown = false }") &&
      content.includes("sourceSelection: \u0027parser\u0027 | \u0027webhook_identity_v1\u0027 = \u0027parser\u0027") &&
      content.includes("selectMaxMessageCandidate(") &&
      publicationTime.includes("selectMaxMessageCandidate(raw as Record<string, unknown>, update.type)?.node") &&
      publicationTime.includes("message?.timestamp ?? message?.createdAt ?? message?.created_at") &&
      semanticKey.includes("extractDuplicateMessageContent(row.raw ?? row, true, \u0027webhook_identity_v1\u0027)") &&
      executionDeadline.includes("extractDuplicateMessageContent(update.raw, true, \u0027webhook_identity_v1\u0027)") &&
      window.includes("local function eventExpiry(at)") &&
      window.includes("math.min(at and at > 0 and at or now, now) + retentionMs") &&
      window.includes("p.windowMs = math.min(p.windowMs, ${DUPLICATE_WINDOW_MAX_SEC * 1000})") &&
      window.includes("\u0027PXAT\u0027, expiry") &&
      window.includes("local expiry = math.min(expiresAt or (now + retentionMs), now + retentionMs)") &&
      window.includes("redis.call(\u0027PEXPIRETIME\u0027, prefix .. key)") &&
      window.includes("if previousExpiry > now then expiry = math.min(expiry, previousExpiry) end") &&
      window.includes("write(stateKey(p.member), state, windowExpiry(state.at), true)") &&
      window.includes("math.min((p.windowMs or 0) + graceMs, retentionMs)") &&
      count(window, "materialized = previous and previous.materialized or nil") === 2 &&
      window.includes("life.materialized = { epoch = currentEpoch, at = p.at, source = p.source, identity = p.identity }") &&
      window.includes("local resetIncarnation = materialized and materialized.epoch ~= currentEpoch") &&
      squash(window).includes("if resetIncarnation and (p.at <= materialized.at or p.identity == \u0027\u0027 or not materialized.identity or materialized.identity == \u0027\u0027 or p.identity == materialized.identity) then return cjson.encode({ kind = \u0027stale\u0027 }) end") &&
      squash(window).includes("if not materialized and ((previousLife and previousLife.materializedRevision) or (priorLife and priorLife.materializedRevision)) and currentEpoch ~= 0 then return cjson.encode({ kind = \u0027stale\u0027 }) end") &&
      window.includes("if life.introducedAt <= currentEpoch then return cjson.encode({ kind = \u0027stale\u0027 }) end") &&
      window.includes("if previous and previous.epoch == currentEpoch and previous.source ~= p.source") &&
      window.includes("elseif previous and previous.epoch == currentEpoch and previous.revision == life.revision") &&
      settings.includes("DUPLICATE_WINDOW_MAX_SEC = 48 * 3_600") &&
      settings.includes("return Math.min(DUPLICATE_WINDOW_MAX_SEC, configured)") &&
      content.includes("export function isDuplicateContentComparable(") &&
      content.includes("if (!isDuplicateContentComparable(content, mode)) return null;") &&
      content.includes("content.complete || (mode === \u0027TEXT\u0027 && content.reason === \u0027unsupported_attachment\u0027)") &&
      history.includes("pendingSafe: isDuplicateContentComparable(input.content, mode)") &&
      history.includes("return isDuplicateContentComparable(content, mode)") &&
      /messageDuplicateSettingsDigest\(settings\)\)\s*!==\s*binding.settingsDigest/u.test(guard) &&
      authorization.includes("binding.version !== 3") &&
      authorization.includes("Date.now() >= authority.deadlineAtMs") &&
      authorization.includes("moderationViolationMessageClaim.findUnique(") &&
      authorization.includes("duplicateRevocationKey(chatId, binding.messageId, timestamp)") &&
      authorization.includes("this.ordering.readActionEligibility(") &&
      /providers:\s*\[[\s\S]*?MessageDuplicateAuthorizationService/u.test(module) &&
      /exports:\s*\[[\s\S]*?MessageDuplicateAuthorizationService/u.test(module) &&
      /providers:\s*\[[\s\S]*?MessageDuplicateAdmissionService/u.test(module) &&
      /exports:\s*\[[\s\S]*?MessageDuplicateAdmissionService/u.test(module) &&
      admission.includes("class MessageDuplicateAdmissionService") &&
      admission.includes("message-duplicate-admission:v1:") &&
      admission.includes("moderationViolationMessageClaim.createMany(") &&
      admission.includes("skipDuplicates: true") &&
      admission.includes("messageActionKey: null") &&
      admission.includes("moderationViolationMessageClaim.findUnique(") &&
      admission.includes("registration: created.count > 0 ?") &&
      /registration:\s*created\.count > 0 \? .initial. : .retry./u.test(admission) &&
      admission.includes("admittedAtMs: stored.createdAt.getTime()") &&
      queue.includes("private readonly admission?: MessageDuplicateAdmissionService") &&
      queue.includes("await this.admission.register(") &&
      queue.includes("registrationKind = existingJob ?") &&
      /registrationKind = existingJob \? .retry. : admission\.registration/u.test(queue) &&
      /this\.ordering\.announce\([\s\S]*?registrationKind,/u.test(queue) &&
      enforcement.includes("await this.guard.assertQualificationAuthority(") &&
      enforcement.includes("beforeSanctionMutation:") &&
      schema.includes("duplicatePolicyRevision") && schema.includes("duplicateHistoryRevision") &&
      migration.includes("chat_duplicate_policy_signature") &&
      migration.includes("OLD.\"duplicate_policy_revision\" +") &&
      migration.includes("OLD.\"duplicate_history_revision\" +") &&
      migration.includes("BEFORE INSERT OR UPDATE ON \"chat_settings\"") &&
      (guardedReasons
        ? reasons.includes("Message duplicate delete guard unavailable") &&
          reasons.includes("this.messageDuplicateDeleteGuard!.assertIntentStillActionable(params)")
        : boundary.includes("intent.messageDuplicateOwned") &&
          boundary.includes("Message duplicate delete guard unavailable") &&
          boundary.includes("await this.messageDuplicateDeleteGuard.assertIntentStillActionable(")) &&
      authorityStart >= 0 && authorityEnd > authorityStart &&
      authority.includes("await this.assertQualificationAuthority(params.chatId, binding)") &&
      authority.includes("await this.history.stillMatches(params.chatId, binding)") &&
      /await this\.assertAuthorization\(params\.chatId, binding\);\s*return .allowed./u.test(authority) &&
      mutationStart >= 0 && mutationEnd > mutationStart &&
      suggestionProof >= 0 && finalPermit > suggestionProof &&
      (!markedMutation || (count(mutation, "await beforeFinalAuthority?.()") === 1 &&
        (preparedReasons ? preparedCheckpoint : transportCheckpoint > suggestionProof) &&
        finalDeadlineFence > transportCheckpoint && finalPermit > finalDeadlineFence)) &&
      (mutation.slice(suggestionProof, finalPermit).includes("intent.messageDuplicateOwned") ||
        (guardedReasons && mutation.slice(suggestionProof, finalPermit).includes("textProof.messageDuplicateVerified"))) &&
      /assertIntentStillActionable\(\{[^}]*authorityOnly:\s*true,[^}]*\}\)/u.test(mutation.slice(finalPermit)) &&
      executor.includes("messageDuplicateEnforcementScope(binding)") &&
      executor.includes("AS \"messageDuplicateOwned\"");
    process.exit(valid ? 0 : 1);
  ' >/dev/null 2>&1; then
    echo "Rollback target lacks the message duplicate v3 lifecycle/revocation/pre-dispatch or Unicode-near capability." >&2
    return 1
  fi
}

maxim_topology_require_participant_report_guard() {
  local commit_sha="$1"
  local guard_source
  local executor_source
  local view_source
  local submission_source
  # FLAG: Persisted report deletes must retain their policy and identity checks after rollback.
  if ! guard_source="$(git show "${commit_sha}:apps/api/src/moderation/reports/report-delete-guard.service.ts" 2>/dev/null)" ||
    ! executor_source="$(git show "${commit_sha}:apps/api/src/moderation/moderation-delete-intent.service.ts" 2>/dev/null)"; then
    echo "Rollback target predates the participant report guard." >&2
    return 1
  fi
  # FLAG: The JavaScript parser matches quote literals, including backticks, without shell expansion.
  # shellcheck disable=SC2016
  if ! printf '%s\0%s' "$guard_source" "$executor_source" | node -e '
    const parts = require("node:fs").readFileSync(0).toString("utf8").split("\0");
    if (parts.length !== 2) process.exit(1);
    const [guard, executor] = parts;
    const start = executor.indexOf("private async runDeletePreDispatchGuards(");
    const end = executor.indexOf("\n  private ", start + 1);
    const boundary = executor.slice(start, end);
    const independentStart = executor.indexOf("private hasExecutableIndependentReportReason(");
    const independentEnd = executor.indexOf("\n  private ", independentStart + 1);
    const independent = executor.slice(independentStart, independentEnd);
    const code = (source) => source.replace(/("(?:\\.|[^"\\])*"|\u0027(?:\\.|[^\u0027\\])*\u0027|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu,
      (match, literal) => literal ?? "").replace(/\s+/gu, " ").trim();
    const reasonStart = executor.indexOf("private async authorizeGuardedUserDeleteReasons(");
    const reasonEnd = executor.indexOf("\n  private ", reasonStart + 1);
    const reasons = code(executor.slice(reasonStart, reasonEnd));
    const preparedBoundary = code(boundary);
    const prepared = preparedBoundary.includes("reportPreparation") || reasons.includes("const candidates: Candidate[] = [];");
    // FLAG: Both report-only composition and non-report cleanup must consume their
    // own prepared capsule after admission; independent report reasons cannot self-authorize.
    const preparedWiring = reasonStart >= 0 && reasonEnd > reasonStart &&
      executor.split("private async runDeletePreDispatchGuards(").length === 2 &&
      executor.split("private async authorizeGuardedUserDeleteReasons(").length === 2 &&
      /return finalizeDeleteAuthority\(\s*await this\.prepareForDispatch\(params\)\s*,?\s*\);/u.test(code(guard)) &&
      preparedBoundary.includes("if (this.reportDeleteGuard && !hasReportReason) reportPreparation = await this.reportDeleteGuard.prepareForDispatch({ intentId: intent.id, chatId: intent.chatId, messageId: intent.messageId, subjectUserId: intent.subjectUserId, botId,") &&
      preparedBoundary.includes("REPORT_GUARDED_RULES.has(r.ruleCode)") &&
      preparedBoundary.includes("const proof = await this.authorizeGuardedUserDeleteReasons( intent, botId, finalDispatchLeaseToken, async () => { await beforeFinalAuthority?.(); imageTextStopListGuard = await finalizeDeleteAuthority(imageTextPreparation); const report = await finalizeDeleteAuthority(reportPreparation); if (report === \u0027absent\u0027) throw new ModerationDeleteGuardedMessageAbsentError(\u0027guarded_report_absence\u0027);") &&
      preparedBoundary.split("const report = await finalizeDeleteAuthority(reportPreparation);").length === 2 &&
      reasons.includes("if (reasons.some((r) => REPORT_GUARDED_RULES.has(r.ruleCode))) { if (!this.reportDeleteGuard) throw new Error(\u0027Participant report delete guard unavailable\u0027);") &&
      reasons.includes("const reportParams = { ...params,") &&
      reasons.includes("isIndependentReasonExecutable: () => false,") &&
      reasons.includes("await prepare(() => deferred ? this.reportDeleteGuard!.prepareForDispatch(reportParams) : this.reportDeleteGuard!.assertIntentStillActionable(reportParams), );") &&
      reasons.includes("const preparation = await run();") &&
      reasons.includes("if (preparation === \u0027absent\u0027) throw new ModerationDeleteGuardedMessageAbsentError(\u0027guarded_current_message_absence\u0027);") &&
      reasons.includes("candidates.push({ preparation, keys, tag, fixedDeadlines });") &&
      reasons.includes("const result = await finalizeDeleteAuthority(candidate.preparation);") &&
      /if \(result === \u0027absent\u0027\) throw new ModerationDeleteGuardedMessageAbsentError\(/u.test(reasons) &&
      /if \(result !== \u0027allowed\u0027 && \(typeof result !== \u0027object\u0027 \|\| result === null\)\)/u.test(reasons) &&
      reasons.split("await beforeFinalAuthority?.();").length === 2 &&
      reasons.indexOf("await beforeFinalAuthority?.();") >= 0 &&
      reasons.indexOf("await beforeFinalAuthority?.();") < reasons.indexOf("const finalizeCandidates = async (") &&
      reasons.includes("return finalizeCandidates(candidates, true);");
    process.exit(start >= 0 && end > start &&
      guard.includes("class ReportDeleteGuardService") &&
      guard.includes("BINDING_VERSION = 3") &&
      guard.includes("REPORT_COUNTER_RULE") &&
      guard.includes("counterMessageId: params.messageId") &&
      guard.includes("for (const reason of reportReasons)") &&
      guard.includes("params.isIndependentReasonExecutable?.(independentReasons)") &&
      independentStart >= 0 && independentEnd > independentStart &&
      independent.includes("this.getRolloutForInput({") &&
      independent.includes("event: { metadata: reason.metadata }") &&
      /===\s*\x27execute\x27/u.test(independent) &&
      executor.includes("if (intent.reportDeleteReason === true) return true;") &&
      executor.includes("AS \"reportDeleteReason\"") &&
      executor.includes("AS \"reportCounterCleanupReason\"") &&
      guard.includes("this.state.assertCurrent(") &&
      guard.includes("this.state.assertPolicy(report)") &&
      guard.includes("this.state.assertCase(") &&
      (prepared ? preparedWiring : boundary.includes("await this.reportDeleteGuard.assertIntentStillActionable(")) &&
      boundary.includes("this.hasExecutableIndependentReportReason(intent.chatId, reasons)") &&
      boundary.includes("Participant report delete guard unavailable") ? 0 : 1);
  ' >/dev/null 2>&1; then
    echo "Rollback target lacks the participant report v3 independent execution/counter guard." >&2
    return 1
  fi
  # FLAG: Archive erasure persists after an environment downgrade; both rollback paths require its readers.
  if ! view_source="$(git show "${commit_sha}:apps/api/src/moderation/reports/report-view.service.ts" 2>/dev/null)" ||
    ! submission_source="$(git show "${commit_sha}:apps/api/src/moderation/reports/report-submission.service.ts" 2>/dev/null)"; then
    echo "Rollback target predates participant report archive readers." >&2
    return 1
  fi
  if ! printf '%s\0%s' "$view_source" "$submission_source" | node -e '
    const parts = require("node:fs").readFileSync(0).toString("utf8").split("\0");
    if (parts.length !== 2) process.exit(1);
    const [view, submission] = parts;
    const summaryStart = view.indexOf("private async summaries(");
    const summaryEnd = view.indexOf("\n  async list(", summaryStart + 1);
    const summary = view.slice(summaryStart, summaryEnd);
    const detailStart = view.indexOf("async detail(");
    const detailEnd = view.indexOf("\n  async dismiss(", detailStart + 1);
    const detail = view.slice(detailStart, detailEnd);
    const transactionStart = submission.indexOf("const report = await this.state.transaction(");
    const tombstone = submission.indexOf("if (current?.detailsArchivedAt)", transactionStart);
    const reopen = submission.indexOf("current.policyRevision !== policy.reportsRevision", transactionStart);
    const retainedFields = ["retainedVotes", "retainedCandidates", "retainedDeleted", "retainedAbsent", "retainedFailed"];
    const compatible = view.includes("ARCHIVE_READER_VERSION = 1") &&
      summaryStart >= 0 && summaryEnd > summaryStart &&
      summary.includes("reports.filter((report) => !report.detailsArchivedAt)") &&
      summary.includes("const archived = Boolean(report.detailsArchivedAt)") &&
      summary.includes("return reports.map((report) => {") &&
      retainedFields.every(field => new RegExp("archived\\s*\\?\\s*report\\." + field + "\\b", "u").test(summary)) &&
      summary.includes("detailsArchived: archived") &&
      detailStart >= 0 && detailEnd > detailStart &&
      /const reporters = report\.detailsArchivedAt\s*\?\s*\[\]\s*:/u.test(detail) &&
      transactionStart >= 0 && tombstone > transactionStart && reopen > tombstone &&
      /if \(current\?\.detailsArchivedAt\)\s*throw new ReportRejectedError\(/u.test(submission.slice(tombstone, reopen));
    process.exit(compatible ? 0 : 1);
  ' >/dev/null 2>&1; then
    echo "Rollback target lacks participant report archive v1 retained-total/tombstone readers." >&2
    return 1
  fi
}

maxim_topology_require_message_retention_guard() {
  local commit_sha="$1"
  local executor_source
  # FLAG: Old critical sweepers do not understand background-only retention intents.
  if ! executor_source="$(git show "${commit_sha}:apps/api/src/moderation/moderation-delete-intent.service.ts" 2>/dev/null)"; then
    echo "Rollback target has no message retention guard." >&2
    return 1
  fi
  if ! printf '%s' "$executor_source" | node -e '
    const source = require("node:fs").readFileSync(0).toString("utf8");
    process.exit(source.includes("await this.messageRetentionGuard.assertAllowed(") &&
      source.includes("intent.\"retention_owned\" = FALSE") &&
      source.includes("Retention delete guard unavailable") &&
      source.includes("async reconcileRetentionIntent(") &&
      source.includes("guardError instanceof MessageRetentionGuardError && latest.retentionOwned") ? 0 : 1);
  '; then
    echo "Rollback target predates isolated message retention receipt recovery." >&2
    return 1
  fi
}

maxim_topology_require_suggestion_subscription_guard() {
  local commit_sha="$1"
  local major_source publisher_source
  # FLAG: Pending suggestion deletes must retain their exact-source and subscription guards.
  if ! major_source="$(git show "${commit_sha}:apps/api/src/moderation/moderation-delete-intent.service.ts" 2>/dev/null)" ||
    ! publisher_source="$(git show "${commit_sha}:apps/api/src/publisher/publisher-publication-post-actions.service.ts" 2>/dev/null)"; then
    echo "Rollback target has no suggestion subscription guard." >&2
    return 1
  fi
  if [[ "$major_source" != *'this.suggestionSubscriptions!.assertDeletionAllowed(suggestionProof)'* ]] ||
    [[ "$publisher_source" != *'this.subscriptions!.assertDeletionAllowed(subscriptionProof)'* ]]; then
    echo "Rollback target predates guarded suggestion subscription deletion." >&2
    return 1
  fi
}

maxim_topology_require_traffic_protection_guard() {
  local commit_sha="$1"
  local guard_source
  local executor_source
  # FLAG: Pending traffic intents must never outlive their final policy/source guard.
  if ! guard_source="$(git show "${commit_sha}:apps/api/src/moderation/traffic-protection-delete-guard.service.ts" 2>/dev/null)" ||
    ! executor_source="$(git show "${commit_sha}:apps/api/src/moderation/moderation-delete-intent.service.ts" 2>/dev/null)"; then
    echo "Rollback target predates the traffic protection guard." >&2
    return 1
  fi
  if ! printf '%s\0%s' "$guard_source" "$executor_source" | node -e '
    const input = require("node:fs").readFileSync(0);
    if (input.length > 4 * 1024 * 1024) process.exit(1);
    const parts = input.toString("utf8").split("\0");
    if (parts.length !== 2) process.exit(1);
    const [guard, executor] = parts;
    const start = executor.indexOf("private async runDeletePreDispatchGuards(");
    const end = executor.indexOf("\n  private ", start + 1);
    const boundary = executor.slice(start, end);
    const reasonStart = executor.indexOf("private async authorizeGuardedUserDeleteReasons(");
    const reasonEnd = executor.indexOf("\n  private ", reasonStart + 1);
    const reasons = executor.slice(reasonStart, reasonEnd);
    const authority = boundary.includes("await this.authorizeGuardedUserDeleteReasons(") ? reasons : boundary;
    const valid = start >= 0 && end > start &&
      guard.includes("class TrafficProtectionDeleteGuardService") &&
      guard.includes("getExactMessageRow(") && guard.includes("trafficPolicyRevision") &&
      guard.includes("traffic_protection_delete_no_longer_authorized") &&
      /this\.trafficProtectionDeleteGuard!?\.assertIntentStillActionable\(/u.test(authority) &&
      authority.includes("Traffic protection delete guard unavailable");
    process.exit(valid ? 0 : 1);
  ' >/dev/null 2>&1; then
    echo "Rollback target lacks the traffic protection pre-dispatch guard." >&2
    return 1
  fi
}

maxim_topology_require_stop_words_policy_guard() {
  local commit_sha="$1"
  local guard_source
  local executor_source
  local detector_source
  local guard_path="apps/api/src/moderation/stop-words/stop-words-delete-guard.service.ts"
  local executor_path="apps/api/src/moderation/moderation-delete-intent.service.ts"
  local detector_path="apps/api/src/moderation/rule-engine.service.impl.ts"

  # FLAG: Persisted stop-word policies and queued decisions cannot be executed by legacy readers.
  if ! guard_source="$(git show "${commit_sha}:${guard_path}" 2>/dev/null)" ||
    ! executor_source="$(git show "${commit_sha}:${executor_path}" 2>/dev/null)" ||
    ! detector_source="$(git show "${commit_sha}:${detector_path}" 2>/dev/null)"; then
    echo "Rollback target predates the stop-word policy guard." >&2
    return 1
  fi
  if ! printf '%s\0%s\0%s' "$guard_source" "$executor_source" "$detector_source" | node -e '
    const input = require("node:fs").readFileSync(0);
    if (input.length > 4 * 1024 * 1024) process.exit(1);
    const parts = input.toString("utf8").split("\0");
    if (parts.length !== 3) process.exit(1);
    const [guard, executor, detector] = parts;
    const start = executor.indexOf("private async runDeletePreDispatchGuards(");
    const end = executor.indexOf("\n  private ", start + 1);
    const boundary = executor.slice(start, end);
    const reasonStart = executor.indexOf("private async authorizeGuardedUserDeleteReasons(");
    const reasonEnd = executor.indexOf("\n  private ", reasonStart + 1);
    const reasons = executor.slice(reasonStart, reasonEnd);
    const authority = boundary.includes("await this.authorizeGuardedUserDeleteReasons(") ? reasons : boundary;
    const valid = start >= 0 && end > start &&
      guard.includes("class StopWordsDeleteGuardService") &&
      guard.includes("getExactMessageRow(") &&
      guard.includes("stop_words_delete_no_longer_authorized") &&
      guard.includes("stopWordsRevision") &&
      /this\.stopWordsDeleteGuard!?\.(?:assertIntentStillActionable|authorizeIntent)\(/u.test(authority) &&
      authority.includes("Stop-list delete guard unavailable") &&
      detector.includes("detectStopWordsViolations(") && detector.includes("stopWordsPolicy");
    process.exit(valid ? 0 : 1);
  ' >/dev/null 2>&1; then
    echo "Rollback target lacks the stop-word policy pre-dispatch guard capability." >&2
    return 1
  fi
}

maxim_topology_require_commercial_text_delete_guard() {
  local commit_sha="$1"
  local binding_source guard_source executor_source
  # FLAG: Read this invariant twice before changes. Binding v2 and global off authority
  # must survive rollback; pending commercial reasons cannot reach an earlier executor.
  if ! binding_source="$(git show "${commit_sha}:apps/api/src/moderation/commercial/commercial-delete-binding.ts" 2>/dev/null)" ||
    ! guard_source="$(git show "${commit_sha}:apps/api/src/moderation/commercial/commercial-delete-guard.service.ts" 2>/dev/null)" ||
    ! executor_source="$(git show "${commit_sha}:apps/api/src/moderation/moderation-delete-intent.service.ts" 2>/dev/null)"; then
    echo "Rollback target predates the commercial text delete guard." >&2
    return 1
  fi
  if ! printf '%s\0%s\0%s' "$binding_source" "$guard_source" "$executor_source" | node -e '
    const input = require("node:fs").readFileSync(0);
    if (input.length > 4 * 1024 * 1024) process.exit(1);
    const parts = input.toString("utf8").split("\0");
    if (parts.length !== 3) process.exit(1);
    const [binding, guard, executor] = parts;
    const start = executor.indexOf("private async runDeletePreDispatchGuards(");
    const end = executor.indexOf("\n  private ", start + 1);
    const boundary = executor.slice(start, end);
    const dispatch = boundary.indexOf("if (finalDispatchLeaseToken)");
    const call = boundary.indexOf("await this.commercialDeleteGuard.assertIntentStillActionable(");
    const reasonStart = executor.indexOf("private async authorizeGuardedUserDeleteReasons(");
    const reasonEnd = executor.indexOf("\n  private ", reasonStart + 1);
    const reasons = executor.slice(reasonStart, reasonEnd);
    const reasonCall = boundary.indexOf("await this.authorizeGuardedUserDeleteReasons(");
    const independent = reasonStart >= 0 && reasonEnd > reasonStart && reasonCall > dispatch &&
      reasons.includes("ownedReasonsOnly: true") && reasons.includes("if (!reasons.length)") &&
      /this\.commercialDeleteGuard!?\.assertIntentStillActionable\(/u.test(reasons) &&
      reasons.includes("Commercial delete guard unavailable");
    const valid = start >= 0 && end > start && dispatch >= 0 && (call > dispatch || independent) &&
      /COMMERCIAL_TEXT_DELETE_BINDING_VERSION\s*=\s*2\s+as const/u.test(binding) &&
      guard.includes("class CommercialDeleteGuardService") &&
      guard.includes("getExactMessageRow(") && guard.includes("isCommercialTextDeleteBindingCurrent(") &&
      guard.includes("commercial_text_binding_stale") &&
      guard.includes("await this.assertAuthority(") &&
      guard.includes("createSanctionPermit(") &&
      guard.includes("async authorizeSanction(") &&
      binding.includes("textRuntimeRevision") &&
      (boundary.includes("Commercial delete guard unavailable") || independent) &&
      executor.includes("commercialVerifiedReasonKeys.length > 0") &&
      executor.includes("Prisma.join(commercialVerifiedReasonKeys)");
    process.exit(valid ? 0 : 1);
  ' >/dev/null 2>&1; then
    echo "Rollback target lacks the commercial text pre-dispatch guard capability." >&2
    return 1
  fi
}

maxim_topology_image_has_ocr_native_sandbox() {
  local image="$1"
  local capability

  if ! capability="$(
    docker image inspect \
      --format "{{index .Config.Labels \"$MAXIM_OCR_NATIVE_SANDBOX_CAPABILITY_LABEL\"}}" \
      "$image" 2>/dev/null
  )"; then
    echo "Could not inspect the OCR sandbox capability on API image: $image" >&2
    return 2
  fi
  case "$capability" in
    true) return 0 ;;
    '' | '<no value>') return 1 ;;
    *)
      echo "API image has an invalid OCR sandbox capability label." >&2
      return 2
      ;;
  esac
}

maxim_topology_git_commercial_ocr_version() {
  local commit_sha="$1"
  local source_path="apps/api/src/moderation/commercial-ocr/commercial-ocr.queue.ts"
  local source
  local version
  local versions=()

  if ! source="$(git show "${commit_sha}:${source_path}" 2>/dev/null)"; then
    echo "Target commit is missing the commercial OCR behavior version source: $commit_sha" >&2
    return 1
  fi

  mapfile -t versions < <(
    printf '%s\n' "$source" | sed -nE \
      -e "s/^[[:space:]]*export const COMMERCIAL_OCR_DEFAULT_VERSION[[:space:]]*=[[:space:]]*'([^']+)'([[:space:]]+as[[:space:]]+const)?;[[:space:]]*$/\\1/p" \
      -e 's/^[[:space:]]*export const COMMERCIAL_OCR_DEFAULT_VERSION[[:space:]]*=[[:space:]]*"([^"]+)"([[:space:]]+as[[:space:]]+const)?;[[:space:]]*$/\1/p'
  )
  if [[ "${#versions[@]}" -ne 1 ]]; then
    echo "Target commit must define exactly one literal COMMERCIAL_OCR_DEFAULT_VERSION: $commit_sha" >&2
    return 1
  fi

  version="${versions[0]}"
  if [[ ! "$version" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
    echo "Target commit defines an invalid COMMERCIAL_OCR_DEFAULT_VERSION: $commit_sha" >&2
    return 1
  fi
  printf '%s' "$version"
}

maxim_topology_require_api_commercial_ocr_version_config() {
  local compose_args_var="$1"
  local expected_version="$2"
  local publisher_policy="${3:-required}"
  local -n compose_args_ref="$compose_args_var"
  local config

  if ! config="$(docker compose "${compose_args_ref[@]}" config --format json 2>/dev/null)"; then
    echo "Could not resolve effective Compose configuration for the commercial OCR version." >&2
    return 1
  fi
  if ! printf '%s' "$config" | node -e '
      const { readFileSync } = require("node:fs");
      const expectedVersion = process.argv[1];
      const publisherPolicy = process.argv[2];
      const services = process.argv.slice(3);
      const config = JSON.parse(readFileSync(0).toString("utf8"));
      const configuredServices = services.filter((service) => config?.services?.[service]);
      const missingServices = services.filter((service) => !config?.services?.[service]);
      const valid =
        services.length === 14 &&
        new Set(services).size === services.length &&
        (missingServices.length === 0 ||
          (publisherPolicy === "allow-absent" &&
            missingServices.length === 1 &&
            missingServices[0] === "api-publisher")) &&
        configuredServices.every(
          (service) =>
            config?.services?.[service]?.environment?.COMMERCIAL_OCR_VERSION === expectedVersion,
        );
      process.exit(valid ? 0 : 1);
    ' "$expected_version" "$publisher_policy" "${MAXIM_PRODUCTION_API_SERVICES[@]}" >/dev/null 2>&1; then
    echo "Refusing API rollout unless every production API role has the target COMMERCIAL_OCR_VERSION." >&2
    return 1
  fi
}

maxim_topology_prepare_commercial_ocr_target() {
  local commit_sha="$1"
  local compose_args_var="$2"
  local has_media_analysis_var="$3"
  local version_var="$4"
  local has_ocr_native_sandbox_var="${5:-}"
  local topology_status
  local resolved_version
  local publisher_policy="required"
  local has_ocr_native_sandbox=0

  printf -v "$has_media_analysis_var" '%s' 0
  printf -v "$version_var" '%s' ''
  if [[ -n "$has_ocr_native_sandbox_var" ]]; then
    printf -v "$has_ocr_native_sandbox_var" '%s' 0
  fi
  if maxim_topology_git_has_ocr_native_sandbox "$commit_sha"; then
    has_ocr_native_sandbox=1
    if [[ -n "$has_ocr_native_sandbox_var" ]]; then
      printf -v "$has_ocr_native_sandbox_var" '%s' 1
    fi
  else
    topology_status=$?
    if [[ "$topology_status" -ne 1 ]]; then
      return "$topology_status"
    fi
  fi
  if maxim_topology_git_compose_has_service "$commit_sha" "$MAXIM_MEDIA_ANALYSIS_SERVICE"; then
    printf -v "$has_media_analysis_var" '%s' 1
  else
    topology_status=$?
    if [[ "$topology_status" -eq 1 ]]; then
      if [[ "$has_ocr_native_sandbox" -eq 1 ]]; then
        echo "Target source defines $MAXIM_OCR_NATIVE_SANDBOX_SERVICE without $MAXIM_MEDIA_ANALYSIS_SERVICE." >&2
        return 1
      fi
      return 0
    fi
    return "$topology_status"
  fi

  if ! resolved_version="$(maxim_topology_git_commercial_ocr_version "$commit_sha")"; then
    return 1
  fi
  printf -v "$version_var" '%s' "$resolved_version"
  export COMMERCIAL_OCR_VERSION="$resolved_version"
  if maxim_topology_git_compose_has_service "$commit_sha" "$MAXIM_PUBLISHER_SERVICE"; then
    :
  else
    local publisher_status=$?
    if [[ "$publisher_status" -eq 1 ]]; then
      publisher_policy="allow-absent"
    else
      return "$publisher_status"
    fi
  fi
  maxim_topology_require_api_commercial_ocr_version_config \
    "$compose_args_var" "$resolved_version" "$publisher_policy"
  # FLAG: A requested mode is delivered only through the fenced shared-image release.
  local requested_mode
  requested_mode="$(maxim_topology_requested_commercial_ocr_deploy_mode)" || return
  if [[ "$requested_mode" == baseline ]] && ! maxim_topology_git_supports_commercial_ocr_baseline "$commit_sha"; then
    echo "Target lacks strict commercial OCR baseline authority." >&2; return 1
  fi
  if [[ -n "$requested_mode" ]]; then
    export COMMERCIAL_OCR_ROLLOUT_MODE="$requested_mode"
    export COMMERCIAL_OCR_CANARY_CHAT_IDS=''
  fi
  maxim_topology_require_media_analysis_rollout_config "$compose_args_var" "$commit_sha"
  if [[ "$has_ocr_native_sandbox" -eq 1 ]]; then
    maxim_topology_require_ocr_native_sandbox_config "$compose_args_var"
  fi
}

maxim_topology_verify_api_commercial_ocr_version() {
  local compose_args_var="$1"
  local expected_version="$2"
  local publisher_policy="${3:-required}"
  local -n compose_args_ref="$compose_args_var"
  local service
  local container_id
  local container_env
  local entry
  local actual_version
  local matches
  local actual_mode mode_matches canary_matches actual_canary

  if [[ "${#MAXIM_PRODUCTION_API_SERVICES[@]}" -ne 14 ]]; then
    echo "Commercial OCR version verification requires the reviewed 14-role API topology." >&2
    return 1
  fi
  for service in "${MAXIM_PRODUCTION_API_SERVICES[@]}"; do
    if [[ "$service" == "$MAXIM_PUBLISHER_SERVICE" && "$publisher_policy" == "allow-absent" ]]; then
      continue
    fi
    container_id="$(docker compose "${compose_args_ref[@]}" ps -q "$service" 2>/dev/null || true)"
    if [[ -z "$container_id" ]]; then
      echo "Cannot verify commercial OCR version for missing API service container: $service" >&2
      return 1
    fi
    if ! container_env="$(
      docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" 2>/dev/null
    )"; then
      echo "Could not inspect commercial OCR version for API service: $service" >&2
      return 1
    fi

    actual_version=""
    matches=0
    actual_mode=""
    mode_matches=0
    canary_matches=0
    actual_canary=""
    while IFS= read -r entry; do
      if [[ "$entry" == COMMERCIAL_OCR_VERSION=* ]]; then
        actual_version="${entry#COMMERCIAL_OCR_VERSION=}"
        matches=$((matches + 1))
      fi
      if [[ "$entry" == COMMERCIAL_OCR_ROLLOUT_MODE=* ]]; then
        actual_mode="${entry#COMMERCIAL_OCR_ROLLOUT_MODE=}"
        mode_matches=$((mode_matches + 1))
      fi
      if [[ "$entry" == COMMERCIAL_OCR_CANARY_CHAT_IDS=* ]]; then
        actual_canary="${entry#COMMERCIAL_OCR_CANARY_CHAT_IDS=}"
        canary_matches=$((canary_matches + 1))
      fi
    done <<<"$container_env"
    if [[ "$matches" -ne 1 || "$actual_version" != "$expected_version" ]]; then
      echo "$service does not run with the target COMMERCIAL_OCR_VERSION." >&2
      return 1
    fi
    if [[ "${MAXIM_EXPECTED_COMMERCIAL_OCR_ROLLOUT_MODE:-shadow}" == baseline ||
      "${MAXIM_EXPECTED_COMMERCIAL_OCR_ROLLOUT_MODE:-shadow}" == off ]] &&
      [[ "$mode_matches" -ne 1 || "$actual_mode" != "$MAXIM_EXPECTED_COMMERCIAL_OCR_ROLLOUT_MODE" || "$canary_matches" -ne 1 || -n "$actual_canary" ]]; then
      echo "$service does not run with the reviewed commercial OCR $MAXIM_EXPECTED_COMMERCIAL_OCR_ROLLOUT_MODE authority." >&2
      return 1
    fi
  done
}

maxim_topology_stop_media_analysis_before_api_transition() {
  local compose_args_var="$1"
  local -n compose_args_ref="$compose_args_var"
  local container_list
  local container_ids=()
  local container_id
  local running
  local service

  for service in "$MAXIM_MEDIA_ANALYSIS_SERVICE" "$MAXIM_OCR_NATIVE_SANDBOX_SERVICE"; do
    if ! container_list="$(
      docker compose "${compose_args_ref[@]}" ps -a -q "$service" 2>/dev/null
    )"; then
      echo "Could not inspect the current $service container." >&2
      return 1
    fi
    [[ -n "$container_list" ]] || continue
    mapfile -t container_ids <<<"$container_list"
    echo "Stopping the current $service before API behavior transition..."
    docker stop --time 30 "${container_ids[@]}" >/dev/null
    for container_id in "${container_ids[@]}"; do
      running="$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null)" || {
        echo "Could not verify stopped OCR runtime container for $service." >&2
        return 1
      }
      if [[ "$running" != "false" ]]; then
        echo "OCR runtime container remained active after stopping $service." >&2
        return 1
      fi
    done
    container_ids=()
  done
}

maxim_topology_remove_ocr_native_sandbox_container() {
  local compose_args_var="$1"
  local -n compose_args_ref="$compose_args_var"
  local container_list
  local container_ids=()

  if ! container_list="$(
    docker compose "${compose_args_ref[@]}" ps -a -q "$MAXIM_OCR_NATIVE_SANDBOX_SERVICE" 2>/dev/null
  )"; then
    echo "Could not inspect the current $MAXIM_OCR_NATIVE_SANDBOX_SERVICE container." >&2
    return 1
  fi
  [[ -n "$container_list" ]] || return 0
  mapfile -t container_ids <<<"$container_list"
  echo "Stopping and removing $MAXIM_OCR_NATIVE_SANDBOX_SERVICE for a pre-sandbox API target..."
  docker stop --time 30 "${container_ids[@]}" >/dev/null 2>&1 || true
  docker rm -f "${container_ids[@]}" >/dev/null
}

maxim_topology_require_ocr_native_sandbox_absent() {
  local compose_args_var="$1"
  local -n compose_args_ref="$compose_args_var"
  local container_list

  if ! container_list="$(
    docker compose "${compose_args_ref[@]}" ps -a -q \
      "$MAXIM_OCR_NATIVE_SANDBOX_SERVICE" 2>/dev/null
  )"; then
    echo "Could not verify absence of $MAXIM_OCR_NATIVE_SANDBOX_SERVICE." >&2
    return 1
  fi
  if [[ -n "$container_list" ]]; then
    echo "A pre-sandbox API runtime still has $MAXIM_OCR_NATIVE_SANDBOX_SERVICE." >&2
    return 1
  fi
}

maxim_topology_require_commercial_ocr_baseline_guard() {
  local commit_sha="$1"
  local guard_source worker_source intent_source
  # FLAG: A pending v5 baseline delete cannot reach a pre-baseline executor after rollback.
  guard_source="$(git show "${commit_sha}:apps/api/src/moderation/commercial-ocr/commercial-ocr-delete-guard.service.ts" 2>/dev/null)" || return 1
  worker_source="$(git show "${commit_sha}:apps/api/src/moderation/commercial-ocr/commercial-ocr-moderation.service.ts" 2>/dev/null)" || return 1
  intent_source="$(git show "${commit_sha}:apps/api/src/moderation/moderation-delete-intent.service.ts" 2>/dev/null)" || return 1
  if ! printf '%s\0%s\0%s' "$guard_source" "$worker_source" "$intent_source" | node -e '
    const parts=require("node:fs").readFileSync(0).toString("utf8").split("\0");
    if(parts.length!==3) process.exit(1);
    const [guard,worker,intent]=parts;
    const valid=/COMMERCIAL_OCR_DELETE_BINDING_VERSION\s*=\s*5\s+as const/u.test(guard) &&
      guard.includes("sameCommercialOcrEnforcementAuthority(runtime.authority, binding.authority)") &&
      guard.includes("getExactMessageRow(") && worker.includes("isLiveBaselineAuthorityVerified(") &&
      worker.includes("sameCommercialOcrEnforcementAuthority(") &&
      /commercialOcrMode\s*===\s*\x27baseline\x27\s*\?\s*\x27on\x27/u.test(intent);
    process.exit(valid?0:1);
  ' >/dev/null 2>&1; then
    echo "Rollback target lacks strict commercial OCR baseline authority." >&2
    return 1
  fi
}

maxim_topology_git_supports_commercial_ocr_baseline() {
  local commit_sha="$1"
  local runtime_source guard_source
  runtime_source="$(git show "${commit_sha}:apps/api/src/moderation/commercial-ocr/commercial-ocr.runtime.ts" 2>/dev/null)" || return 1
  guard_source="$(git show "${commit_sha}:apps/api/src/moderation/commercial-ocr/commercial-ocr-delete-guard.service.ts" 2>/dev/null)" || return 1
  [[ "$runtime_source" == *"'baseline'"* && "$guard_source" == *"BASELINE"* ]] &&
    maxim_topology_require_commercial_ocr_baseline_guard "$commit_sha"
}

maxim_topology_requested_commercial_ocr_deploy_mode() {
  case "${MAXIM_COMMERCIAL_OCR_BASELINE:-0}:${MAXIM_COMMERCIAL_OCR_OFF:-0}" in
    0:0) ;;
    1:0) printf '%s' baseline ;;
    0:1) printf '%s' off ;;
    *) echo "OCR baseline/off flags must be 0 or 1 and mutually exclusive." >&2; return 2 ;;
  esac
}

maxim_topology_require_media_analysis_rollout_config() {
  local compose_args_var="$1"
  local commit_sha="$2"
  local -n compose_args_ref="$compose_args_var"
  local selected_mode
  selected_mode="$(docker compose "${compose_args_ref[@]}" config --format json 2>/dev/null | node -e '
    const config=JSON.parse(require("node:fs").readFileSync(0).toString("utf8"));
    const mode=config?.services?.["api-media-analysis"]?.environment?.COMMERCIAL_OCR_ROLLOUT_MODE;
    if (!["off","shadow","baseline"].includes(mode)) process.exit(1);
    if (mode === "baseline" || mode === "off") {
      const services=process.argv.slice(1);
      if (services.length!==14 || services.some(name => {
        const env=config?.services?.[name]?.environment;
        return env?.COMMERCIAL_OCR_ROLLOUT_MODE!==mode || env?.COMMERCIAL_OCR_CANARY_CHAT_IDS!=="";
      })) process.exit(1);
    }
    process.stdout.write(mode);
  ' "${MAXIM_PRODUCTION_API_SERVICES[@]}")" || { echo "Refusing an unsupported or inconsistent OCR deployment mode." >&2; return 1; }
  if [[ "$selected_mode" == baseline ]] && ! maxim_topology_git_supports_commercial_ocr_baseline "$commit_sha"; then
    echo "Target lacks strict commercial OCR baseline authority." >&2
    return 1
  fi
  export MAXIM_EXPECTED_COMMERCIAL_OCR_ROLLOUT_MODE="$selected_mode"
}

maxim_topology_require_media_analysis_shadow_config() {
  local compose_args_var="$1"
  local -n compose_args_ref="$compose_args_var"

  if ! docker compose "${compose_args_ref[@]}" config --format json 2>/dev/null \
    | node -e '
        const { readFileSync } = require("node:fs");
        const config = JSON.parse(readFileSync(0).toString("utf8"));
        process.exit(
          config?.services?.["api-media-analysis"]?.environment?.COMMERCIAL_OCR_ROLLOUT_MODE ===
            "shadow"
            ? 0
            : 1,
        );
      ' >/dev/null 2>&1; then
    echo "Refusing media-analysis rollout unless effective COMMERCIAL_OCR_ROLLOUT_MODE=shadow." >&2
    return 1
  fi
}

maxim_topology_require_ocr_native_sandbox_config() {
  local compose_args_var="$1"
  local -n compose_args_ref="$compose_args_var"

  if ! docker compose "${compose_args_ref[@]}" config --format json 2>/dev/null \
    | node -e '
        const { readFileSync } = require("node:fs");
        const config = JSON.parse(readFileSync(0).toString("utf8"));
        const sandbox = config?.services?.["ocr-native-sandbox"];
        const media = config?.services?.["api-media-analysis"];
        const expectedCommand = [
          "node",
          "apps/api/dist/apps/api/src/moderation/commercial-ocr/native-ocr-sandbox.entrypoint.js",
        ];
        const expectedProbe = ["CMD", ...expectedCommand, "--probe"];
        const expectedEnvironment = {
          COMMERCIAL_OCR_MAX_INPUT_PIXELS: "40000000",
          COMMERCIAL_OCR_MAX_OUTPUT_PIXELS: "3000000",
          COMMERCIAL_OCR_MAX_SIDE: "2000",
          COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH: "/run/maxim-ocr/native-ocr.sock",
          COMMERCIAL_OCR_TESSERACT_BINARY: "tesseract",
          COMMERCIAL_OCR_TESSERACT_CONCURRENCY: "1",
          COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES: "16777216",
          COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES: "4194304",
          COMMERCIAL_OCR_TESSERACT_MAX_QUEUE: "4",
          COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS: "250",
          COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: "10000",
          NODE_ENV: "production",
          OMP_THREAD_LIMIT: "1",
          PHOTO_DUPLICATE_MAX_BYTES: "16777216",
        };
        const sameStrings = (left, right) =>
          Array.isArray(left) && left.length === right.length &&
          left.every((value, index) => value === right[index]);
        const exactObject = (left, right) =>
          left && typeof left === "object" && !Array.isArray(left) &&
          Object.keys(left).length === Object.keys(right).length &&
          Object.entries(right).every(([key, value]) => left[key] === value);
        const sandboxVolumes = Array.isArray(sandbox?.volumes) ? sandbox.volumes : [];
        const mediaVolumes = Array.isArray(media?.volumes) ? media.volumes : [];
        const ipcConsumers = Object.entries(config?.services ?? {})
          .filter(([, service]) =>
            (service?.volumes ?? []).some((volume) => volume?.source === "ocr_native_ipc"),
          )
          .map(([name]) => name)
          .sort();
        const sandboxVolume = sandboxVolumes[0];
        const mediaVolume = mediaVolumes.find((volume) => volume?.target === "/run/maxim-ocr");
        const valid =
          sandbox && media &&
          sandbox.labels?.["com.maxim.ocr-native-sandbox"] === "true" &&
          sandbox.network_mode === "none" && sandbox.networks === undefined &&
          sandbox.user === "1000:1000" && sandbox.init === true &&
          sandbox.read_only === true && sandbox.privileged !== true &&
          sandbox.cpus === 1 && sandbox.mem_limit === "1073741824" &&
          sandbox.pids_limit === 128 && sandbox.deploy?.replicas === 1 &&
          sandbox.restart === "unless-stopped" &&
          sameStrings(sandbox.cap_drop, ["ALL"]) &&
          sameStrings(sandbox.security_opt, ["no-new-privileges:true"]) &&
          sameStrings(sandbox.tmpfs, ["/tmp:size=64m,mode=1777,uid=1000,gid=1000"]) &&
          sameStrings(sandbox.command, expectedCommand) &&
          sameStrings(sandbox.healthcheck?.test, expectedProbe) &&
          sandbox.healthcheck?.timeout === "8s" &&
          sandbox.healthcheck?.interval === "10s" &&
          sandbox.healthcheck?.retries === 3 &&
          sandbox.healthcheck?.start_period === "20s" &&
          exactObject(sandbox.environment, expectedEnvironment) &&
          sandbox.secrets === undefined && sandbox.configs === undefined &&
          sandbox.ports === undefined && sandbox.expose === undefined &&
          sandboxVolumes.length === 1 && sandboxVolume?.type === "volume" &&
          sandboxVolume?.source === "ocr_native_ipc" &&
          sandboxVolume?.target === "/run/maxim-ocr" && sandboxVolume?.read_only !== true &&
          mediaVolume?.type === "volume" && mediaVolume?.source === "ocr_native_ipc" &&
          mediaVolume?.read_only === true &&
          sameStrings(ipcConsumers, ["api-media-analysis", "ocr-native-sandbox"]) &&
          Object.entries(expectedEnvironment).every(
            ([key, value]) => media?.environment?.[key] === value,
          ) &&
          media?.depends_on?.["ocr-native-sandbox"]?.condition === "service_healthy";
        process.exit(valid ? 0 : 1);
      ' >/dev/null 2>&1; then
    echo "Refusing OCR sandbox rollout unless the effective no-network/no-secret Compose boundary is exact." >&2
    return 1
  fi
}

maxim_topology_wait_for_ocr_native_sandbox() {
  local compose_args_var="$1"
  local timeout_sec="${2:-180}"
  local -n compose_args_ref="$compose_args_var"
  local deadline=$((SECONDS + timeout_sec))
  local container_list
  local container_ids=()
  local health

  while ((SECONDS < deadline)); do
    container_list="$(
      docker compose "${compose_args_ref[@]}" ps --status running -q \
        "$MAXIM_OCR_NATIVE_SANDBOX_SERVICE" 2>/dev/null || true
    )"
    container_ids=()
    [[ -z "$container_list" ]] || mapfile -t container_ids <<<"$container_list"
    if [[ "${#container_ids[@]}" -eq 1 ]]; then
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
        "${container_ids[0]}" 2>/dev/null || true)"
      if [[ "$health" == "healthy" ]]; then
        return 0
      fi
    fi
    sleep 1
  done
  echo "$MAXIM_OCR_NATIVE_SANDBOX_SERVICE did not become a unique healthy container." >&2
  return 1
}

maxim_topology_recreate_ocr_native_sandbox() {
  local compose_args_var="$1"
  local expected_image_id="${2:-}"
  local -n compose_args_ref="$compose_args_var"

  echo "Recreating isolated OCR native sandbox..."
  docker compose "${compose_args_ref[@]}" up -d --no-deps --no-build --force-recreate \
    "$MAXIM_OCR_NATIVE_SANDBOX_SERVICE"
  maxim_topology_wait_for_ocr_native_sandbox "$compose_args_var" 180
  maxim_topology_verify_ocr_native_sandbox_runtime \
    "$compose_args_var" "$expected_image_id" sandbox-only
}

maxim_topology_verify_ocr_native_sandbox_runtime() {
  local compose_args_var="$1"
  local expected_image_id="${2:-}"
  local media_policy="${3:-with-media}"
  local expected_media_id="${4:-}"
  local -n compose_args_ref="$compose_args_var"
  local sandbox_list
  local media_list
  local sandbox_ids=()
  local media_ids=()
  local inspect_ids=()
  local socket_volume_name
  local volume_consumers_raw
  local volume_consumers=()
  local expected_consumers=()
  local media_ps_args=(ps --status running -q)

  case "$media_policy" in
    sandbox-only | with-media) ;;
    with-stopped-media)
      [[ "$expected_media_id" =~ ^[a-f0-9]{64}$ && -n "$expected_image_id" ]] || return 2
      media_ps_args=(ps -a -q)
      ;;
    *)
      echo "Unknown OCR sandbox runtime media policy: $media_policy" >&2
      return 2
      ;;
  esac
  sandbox_list="$(
    docker compose "${compose_args_ref[@]}" ps --status running -q \
      "$MAXIM_OCR_NATIVE_SANDBOX_SERVICE" 2>/dev/null
  )" || return 1
  [[ -z "$sandbox_list" ]] || mapfile -t sandbox_ids <<<"$sandbox_list"
  if [[ "${#sandbox_ids[@]}" -ne 1 ]]; then
    echo "OCR sandbox runtime must contain exactly one running container." >&2
    return 1
  fi
  inspect_ids=("${sandbox_ids[0]}")
  if [[ "$media_policy" != "sandbox-only" ]]; then
    media_list="$(
      docker compose "${compose_args_ref[@]}" "${media_ps_args[@]}" \
        "$MAXIM_MEDIA_ANALYSIS_SERVICE" 2>/dev/null
    )" || return 1
    [[ -z "$media_list" ]] || mapfile -t media_ids <<<"$media_list"
    if [[ "${#media_ids[@]}" -ne 1 ]]; then
      echo "OCR sandbox attestation requires exactly one media-analysis container in its selected state." >&2
      return 1
    fi
    [[ -z "$expected_media_id" || "${media_ids[0]}" == "$expected_media_id" ]] || return 1
    inspect_ids+=("${media_ids[0]}")
  fi

  socket_volume_name="$(
    docker inspect --format \
      '{{range .Mounts}}{{if eq .Destination "/run/maxim-ocr"}}{{.Name}}{{end}}{{end}}' \
      "${sandbox_ids[0]}" 2>/dev/null
  )" || return 1
  if [[ ! "$socket_volume_name" =~ ^infra(-scale)?_ocr_native_ipc$ ]]; then
    echo "OCR sandbox uses an invalid IPC volume identity." >&2
    return 1
  fi
  volume_consumers_raw="$(
    docker ps --no-trunc -q --filter "volume=$socket_volume_name" 2>/dev/null
  )" || return 1
  [[ -z "$volume_consumers_raw" ]] || mapfile -t volume_consumers <<<"$volume_consumers_raw"
  expected_consumers=("${sandbox_ids[0]}")
  if [[ "$media_policy" == "with-media" ]]; then
    expected_consumers+=("${media_ids[0]}")
  fi
  mapfile -t volume_consumers < <(printf '%s\n' "${volume_consumers[@]}" | sort)
  mapfile -t expected_consumers < <(printf '%s\n' "${expected_consumers[@]}" | sort)
  if [[ "${volume_consumers[*]}" != "${expected_consumers[*]}" ]]; then
    echo "OCR sandbox IPC volume is mounted by an unexpected running container." >&2
    return 1
  fi

  # shellcheck disable=SC2016
  if ! docker inspect "${inspect_ids[@]}" 2>/dev/null \
    | node -e '
        const { readFileSync } = require("node:fs");
        const expectedImageId = process.argv[1];
        const mediaPolicy = process.argv[2];
        const containers = JSON.parse(readFileSync(0).toString("utf8"));
        const sandbox = containers[0];
        const media = containers[1];
        const labels = sandbox?.Config?.Labels ?? {};
        const project = labels["com.docker.compose.project"];
        const env = new Map();
        let envValid = Array.isArray(sandbox?.Config?.Env);
        for (const entry of sandbox?.Config?.Env ?? []) {
          if (typeof entry !== "string") { envValid = false; continue; }
          const separator = entry.indexOf("=");
          if (separator < 1) { envValid = false; continue; }
          const key = entry.slice(0, separator);
          if (env.has(key)) envValid = false;
          env.set(key, entry.slice(separator + 1));
        }
        const allowedEnv = new Set([
          "COMMERCIAL_OCR_MAX_INPUT_PIXELS", "COMMERCIAL_OCR_MAX_OUTPUT_PIXELS",
          "COMMERCIAL_OCR_MAX_SIDE",
          "COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH",
          "COMMERCIAL_OCR_TESSERACT_BINARY",
          "COMMERCIAL_OCR_TESSERACT_CONCURRENCY",
          "COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES",
          "COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES",
          "COMMERCIAL_OCR_TESSERACT_MAX_QUEUE",
          "COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS",
          "COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS",
          "HOME", "HOSTNAME", "NODE_ENV", "NODE_EXTRA_CA_CERTS", "NODE_VERSION",
          "OMP_THREAD_LIMIT", "PATH", "PHOTO_DUPLICATE_MAX_BYTES", "YARN_VERSION",
        ]);
        envValid = envValid && [...env.keys()].every((key) => allowedEnv.has(key));
        const sandboxMounts = Array.isArray(sandbox?.Mounts) ? sandbox.Mounts : [];
        const socketMount = sandboxMounts[0];
        const tmpfs = sandbox?.HostConfig?.Tmpfs ?? {};
        const networkNames = Object.keys(sandbox?.NetworkSettings?.Networks ?? {});
        const securityOpt = sandbox?.HostConfig?.SecurityOpt ?? [];
        const capDrop = sandbox?.HostConfig?.CapDrop ?? [];
        const expectedCommand = [
          "node",
          "apps/api/dist/apps/api/src/moderation/commercial-ocr/native-ocr-sandbox.entrypoint.js",
        ];
        const sameStrings = (left, right) =>
          Array.isArray(left) && left.length === right.length &&
          left.every((value, index) => value === right[index]);
        let valid =
          Array.isArray(containers) && containers.length === (mediaPolicy === "sandbox-only" ? 1 : 2) &&
          sandbox?.State?.Running === true && sandbox?.State?.Status === "running" &&
          sandbox?.State?.Health?.Status === "healthy" &&
          (!expectedImageId || sandbox?.Image === expectedImageId) &&
          labels["com.docker.compose.service"] === "ocr-native-sandbox" &&
          labels["com.maxim.ocr-native-sandbox"] === "true" &&
          labels["com.maxim.ocr-native-sandbox-capable"] === "true" &&
          typeof project === "string" && /^(?:infra|infra-scale)$/u.test(project) &&
          (project !== "infra" || labels["com.maxim.release-protected"] === "true") &&
          sandbox?.Config?.User === "1000:1000" &&
          sameStrings(sandbox?.Config?.Cmd, expectedCommand) &&
          envValid &&
          env.get("NODE_ENV") === "production" &&
          env.get("COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH") ===
            "/run/maxim-ocr/native-ocr.sock" &&
          env.get("PHOTO_DUPLICATE_MAX_BYTES") === "16777216" &&
          env.get("COMMERCIAL_OCR_MAX_INPUT_PIXELS") === "40000000" &&
          env.get("COMMERCIAL_OCR_MAX_OUTPUT_PIXELS") === "3000000" &&
          env.get("COMMERCIAL_OCR_MAX_SIDE") === "2000" &&
          env.get("COMMERCIAL_OCR_TESSERACT_BINARY") === "tesseract" &&
          env.get("COMMERCIAL_OCR_TESSERACT_CONCURRENCY") === "1" &&
          env.get("COMMERCIAL_OCR_TESSERACT_MAX_QUEUE") === "4" &&
          env.get("COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS") === "250" &&
          env.get("COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS") === "10000" &&
          env.get("COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES") === "16777216" &&
          env.get("COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES") === "4194304" &&
          env.get("OMP_THREAD_LIMIT") === "1" &&
          sandbox?.HostConfig?.NetworkMode === "none" &&
          sandbox?.HostConfig?.ReadonlyRootfs === true &&
          sandbox?.HostConfig?.Privileged === false &&
          sandbox?.HostConfig?.Init === true &&
          sandbox?.HostConfig?.RestartPolicy?.Name === "unless-stopped" &&
          sandbox?.HostConfig?.PidsLimit === 128 &&
          sandbox?.HostConfig?.Memory === 1073741824 &&
          sandbox?.HostConfig?.NanoCpus === 1000000000 &&
          sameStrings(capDrop, ["ALL"]) &&
          securityOpt.includes("no-new-privileges:true") &&
          Object.keys(tmpfs).length === 1 &&
          typeof tmpfs["/tmp"] === "string" && tmpfs["/tmp"].includes("size=64m") &&
          sandboxMounts.length === 1 && socketMount?.Type === "volume" &&
          socketMount?.Name === `${project}_ocr_native_ipc` &&
          socketMount?.Destination === "/run/maxim-ocr" && socketMount?.RW === true &&
          networkNames.every((networkName) => networkName === "none");
        if (mediaPolicy !== "sandbox-only") {
          const mediaMounts = (media?.Mounts ?? []).filter(
            (mount) => mount?.Destination === "/run/maxim-ocr",
          );
          const mediaEnvironment = new Map();
          let mediaEnvironmentValid = Array.isArray(media?.Config?.Env);
          for (const entry of media?.Config?.Env ?? []) {
            if (typeof entry !== "string") { mediaEnvironmentValid = false; continue; }
            const separator = entry.indexOf("=");
            if (separator < 1) { mediaEnvironmentValid = false; continue; }
            const key = entry.slice(0, separator);
            if (mediaEnvironment.has(key)) mediaEnvironmentValid = false;
            mediaEnvironment.set(key, entry.slice(separator + 1));
          }
          const nativeProfileKeys = [
            "COMMERCIAL_OCR_MAX_INPUT_PIXELS", "COMMERCIAL_OCR_MAX_OUTPUT_PIXELS",
            "COMMERCIAL_OCR_MAX_SIDE", "COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH",
            "COMMERCIAL_OCR_TESSERACT_BINARY", "COMMERCIAL_OCR_TESSERACT_CONCURRENCY",
            "COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES",
            "COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES", "COMMERCIAL_OCR_TESSERACT_MAX_QUEUE",
            "COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS",
            "COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS", "OMP_THREAD_LIMIT",
            "PHOTO_DUPLICATE_MAX_BYTES",
          ];
          // FLAG: Recovery inspects the exact stopped consumer; it never omits its
          // identity, image, native profile or read-only socket boundary.
          const stoppedMediaValid = media?.Id === process.argv[3] && media?.State?.Running === false &&
            media?.State?.Status === "exited" && media?.State?.Paused === false &&
            media?.State?.Restarting === false && media?.State?.Dead === false &&
            media?.Config?.Labels?.["com.docker.compose.project"] === project &&
            media?.Config?.Labels?.["com.docker.compose.service"] === "api-media-analysis" &&
            media?.Name === `/${project}-api-media-analysis-1` &&
            mediaEnvironment.get("APP_ROLE") === "moderation" &&
            mediaEnvironment.get("APP_SERVICE_NAME") === "api-media-analysis";
          valid = valid && (mediaPolicy === "with-stopped-media"
            ? stoppedMediaValid : media?.State?.Running === true) &&
            (!expectedImageId || media?.Image === expectedImageId) &&
            mediaEnvironmentValid &&
            nativeProfileKeys.every((key) => mediaEnvironment.get(key) === env.get(key)) &&
            mediaMounts.length === 1 && mediaMounts[0]?.Type === "volume" &&
            mediaMounts[0]?.Name === socketMount?.Name && mediaMounts[0]?.RW === false;
        }
        process.exit(valid ? 0 : 1);
      ' "$expected_image_id" "$media_policy" "$expected_media_id" >/dev/null 2>&1; then
    echo "OCR sandbox runtime failed image, isolation, health, or IPC-volume attestation." >&2
    return 1
  fi
}

maxim_topology_verify_ocr_native_sandbox_for_image() {
  maxim_topology_verify_photo_native_sandbox_for_image "$1" "$2" || return 1
  local compose_args_var="$1"
  local image="$2"
  local capability_status

  if maxim_topology_image_has_ocr_native_sandbox "$image"; then
    maxim_topology_verify_ocr_native_sandbox_runtime "$compose_args_var" "$image" with-media
    return
  fi
  capability_status=$?
  if [[ "$capability_status" -ne 1 ]]; then
    return "$capability_status"
  fi
  maxim_topology_require_ocr_native_sandbox_absent "$compose_args_var"
}

maxim_topology_require_ocr_native_sandbox_image_capability() {
  local image="$1"
  local expected="$2"
  local capability_status

  if [[ "$expected" != "0" && "$expected" != "1" ]]; then
    echo "OCR sandbox image capability expectation must be 0 or 1." >&2
    return 2
  fi
  if maxim_topology_image_has_ocr_native_sandbox "$image"; then
    if [[ "$expected" -eq 1 ]]; then
      return 0
    fi
    echo "Pre-sandbox target image unexpectedly declares OCR sandbox capability." >&2
    return 1
  fi
  capability_status=$?
  if [[ "$capability_status" -ne 1 ]]; then
    return "$capability_status"
  fi
  if [[ "$expected" -eq 0 ]]; then
    return 0
  fi
  echo "OCR sandbox target source requires an image with the matching capability label." >&2
  return 1
}

maxim_topology_wait_for_no_ocr_native_processes() {
  local sandbox_id="$1"
  local max_attempts="${2:-15}"
  local attempt

  if [[ -z "$sandbox_id" || ! "$max_attempts" =~ ^[1-9][0-9]*$ || "$max_attempts" -gt 60 ]]; then
    echo "Invalid OCR native process cleanup wait arguments." >&2
    return 2
  fi
  for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
    if docker top "$sandbox_id" -eo pid,comm 2>/dev/null \
      | awk 'NR > 1 && $2 == "tesseract" { found=1 } END { exit found ? 1 : 0 }'; then
      return 0
    fi
    [[ "$attempt" -eq "$max_attempts" ]] || sleep 1
  done
  return 1
}

maxim_topology_smoke_ocr_native_sandbox_uds() {
  local compose_args_var="$1"
  local expected_image_id="${2:-}"
  local client_mode="${3:-running-media}"
  local -n compose_args_ref="$compose_args_var"
  local output
  local sandbox_id
  local runtime_media_policy="with-media"

  case "$client_mode" in
    running-media) ;;
    prestart) runtime_media_policy="sandbox-only" ;;
    *)
      echo "Unknown native OCR UDS smoke client mode: $client_mode" >&2
      return 2
      ;;
  esac

  maxim_topology_require_ocr_native_sandbox_config "$compose_args_var"
  maxim_topology_wait_for_ocr_native_sandbox "$compose_args_var" 180
  maxim_topology_verify_ocr_native_sandbox_runtime \
    "$compose_args_var" "$expected_image_id" "$runtime_media_policy"

  if [[ "$client_mode" == "prestart" ]]; then
    output="$(
      docker compose "${compose_args_ref[@]}" run --rm --no-deps --pull never \
        --entrypoint node "$MAXIM_MEDIA_ANALYSIS_SERVICE" \
        apps/api/dist/apps/api/src/scripts/smoke-commercial-ocr-worker.js 2>&1
    )" || {
      echo "Pre-fence native OCR UDS raster smoke failed." >&2
      [[ -z "$output" ]] || printf '%s\n' "$output" >&2
      return 1
    }
  elif ! output="$(
    docker compose "${compose_args_ref[@]}" exec -T "$MAXIM_MEDIA_ANALYSIS_SERVICE" \
      node apps/api/dist/apps/api/src/scripts/smoke-commercial-ocr-worker.js 2>&1
  )"; then
    echo "Pre-fence native OCR UDS raster smoke failed." >&2
    [[ -z "$output" ]] || printf '%s\n' "$output" >&2
    return 1
  fi
  if ! grep -Fxq 'Commercial OCR worker smoke passed.' <<<"$output"; then
    echo "Pre-fence native OCR UDS raster smoke returned an invalid marker." >&2
    [[ -z "$output" ]] || printf '%s\n' "$output" >&2
    return 1
  fi

  sandbox_id="$(
    docker compose "${compose_args_ref[@]}" ps --status running -q \
      "$MAXIM_OCR_NATIVE_SANDBOX_SERVICE" 2>/dev/null
  )" || return 1
  if [[ -z "$sandbox_id" || "$sandbox_id" == *$'\n'* ]]; then
    echo "Pre-fence native OCR UDS smoke lost the unique sandbox container." >&2
    return 1
  fi
  if ! maxim_topology_wait_for_no_ocr_native_processes "$sandbox_id" 15; then
    echo "Pre-fence native OCR UDS smoke left a Tesseract process behind." >&2
    return 1
  fi
  maxim_topology_verify_ocr_native_sandbox_runtime \
    "$compose_args_var" "$expected_image_id" "$runtime_media_policy"
}

maxim_topology_smoke_media_analysis_tesseract() {
  local compose_args_var="$1"
  local raster_smoke_policy="${2:-required}"
  local native_boundary_policy="${3:-legacy}"
  local readiness_policy="${4:-strict}"
  local -n compose_args_ref="$compose_args_var"
  local raster_smoke_capability
  local native_service="$MAXIM_MEDIA_ANALYSIS_SERVICE"
  local attempt
  local binary
  local output
  local ready=0

  case "$readiness_policy" in
    strict | cold-recovery) ;;
    *) echo "Unknown OCR readiness policy: $readiness_policy" >&2; return 2 ;;
  esac

  case "$raster_smoke_policy" in
    required | if-present)
      ;;
    *)
      echo "Unknown media-analysis raster smoke policy: $raster_smoke_policy" >&2
      return 2
      ;;
  esac
  case "$native_boundary_policy" in
    legacy)
      ;;
    sandbox)
      native_service="$MAXIM_OCR_NATIVE_SANDBOX_SERVICE"
      maxim_topology_require_ocr_native_sandbox_config "$compose_args_var"
      maxim_topology_wait_for_ocr_native_sandbox "$compose_args_var" 180
      maxim_topology_verify_ocr_native_sandbox_runtime "$compose_args_var" '' with-media
      ;;
    *)
      echo "Unknown native OCR boundary smoke policy: $native_boundary_policy" >&2
      return 2
      ;;
  esac

  if [[ "$native_boundary_policy" == "sandbox" ]]; then
    if ! output="$(
      docker compose "${compose_args_ref[@]}" exec -T "$MAXIM_OCR_NATIVE_SANDBOX_SERVICE" \
        node apps/api/dist/apps/api/src/moderation/commercial-ocr/native-ocr-sandbox.entrypoint.js \
        --probe 2>&1
    )"; then
      echo "Native OCR sandbox probe failed." >&2
      [[ -z "$output" ]] || printf '%s\n' "$output" >&2
      return 1
    fi
    if ! grep -Fxq 'Native OCR sandbox probe passed.' <<<"$output"; then
      echo "Native OCR sandbox did not return its exact probe marker." >&2
      [[ -z "$output" ]] || printf '%s\n' "$output" >&2
      return 1
    fi
  else
    if ! binary="$(
      docker compose "${compose_args_ref[@]}" exec -T "$native_service" \
        sh -c 'printf "%s" "${COMMERCIAL_OCR_TESSERACT_BINARY:-tesseract}"' 2>&1
    )"; then
      echo "Could not resolve the configured Tesseract binary in $native_service." >&2
      [[ -z "$binary" ]] || printf '%s\n' "$binary" >&2
      return 1
    fi
    if [[ -z "$binary" || "$binary" == *$'\n'* || "$binary" == *$'\r'* ]]; then
      echo "$native_service has an invalid configured Tesseract binary." >&2
      return 1
    fi

    if ! output="$(
      docker compose "${compose_args_ref[@]}" exec -T "$native_service" \
        "$binary" --list-langs 2>&1
    )"; then
      echo "Tesseract language smoke failed in $native_service." >&2
      [[ -z "$output" ]] || printf '%s\n' "$output" >&2
      return 1
    fi
    if ! grep -Fxq rus <<<"$output" || ! grep -Fxq eng <<<"$output"; then
      echo "$native_service must provide exact Tesseract language entries: rus and eng." >&2
      [[ -z "$output" ]] || printf '%s\n' "$output" >&2
      return 1
    fi
  fi

  if ! docker compose "${compose_args_ref[@]}" exec -T "$MAXIM_MEDIA_ANALYSIS_SERVICE" \
    sh -c 'test "${COMMERCIAL_OCR_ROLLOUT_MODE:-}" = "$1"' sh "${MAXIM_EXPECTED_COMMERCIAL_OCR_ROLLOUT_MODE:-shadow}" >/dev/null 2>&1; then
    echo "$MAXIM_MEDIA_ANALYSIS_SERVICE must match the reviewed OCR deployment mode." >&2
    return 1
  fi

  if ! raster_smoke_capability="$(
    docker compose "${compose_args_ref[@]}" exec -T "$MAXIM_MEDIA_ANALYSIS_SERVICE" \
      sh -c \
      'if [ -f apps/api/dist/apps/api/src/scripts/smoke-commercial-ocr-worker.js ]; then printf present; else printf absent; fi'
  )"; then
    echo "Could not inspect the native OCR worker raster smoke capability in $MAXIM_MEDIA_ANALYSIS_SERVICE." >&2
    return 1
  fi
  case "$raster_smoke_capability" in
    present)
      ;;
    absent)
      if [[ "$raster_smoke_policy" == "required" ]]; then
        echo "$MAXIM_MEDIA_ANALYSIS_SERVICE is missing the required native OCR worker raster smoke." >&2
        return 1
      fi
      echo "Tesseract language smoke passed in legacy $native_service image: rus+eng; raster smoke unavailable."
      return 0
      ;;
    *)
      echo "$MAXIM_MEDIA_ANALYSIS_SERVICE returned an invalid raster smoke capability marker." >&2
      return 1
      ;;
  esac

  # FLAG: Cold recovery must prove the native worker before it can drain the backlog.
  # Only fresh queue-only degradation may pass here; final release smokes stay strict.
  for ((attempt = 1; attempt <= 30; attempt += 1)); do
    if docker compose "${compose_args_ref[@]}" exec -T "$MAXIM_MEDIA_ANALYSIS_SERVICE" \
      node -e \
      'fetch("http://127.0.0.1:3001/api/health/ready", { signal: AbortSignal.timeout(3000) }).then(async (response) => { const body = await response.json(); const lag = body?.checks?.queueLag; const age = Date.now() - Date.parse(lag?.sampleGeneratedAt); const coldBacklog = process.argv[1] === "cold-recovery" && response.status === 503 && body?.ok === false && body?.checks?.database === true && body?.checks?.redis === true && body?.systemMode?.source === "auto" && body?.systemMode?.condition === "queue_backlog" && body?.systemMode?.manualMode === null && lag?.rawOk === false && Number.isFinite(lag?.effectiveLagSec) && lag.effectiveLagSec > 10 && Number.isFinite(age) && age >= -1000 && age <= 15000 && body?.checks?.ocr?.behaviorIdentity?.complete === true && body?.checks?.ocr?.behaviorIdentity?.verified === true; if ((!response.ok || body?.ok !== true) && !coldBacklog || body?.checks?.ocr?.ready !== true) process.exit(1); }).catch(() => process.exit(1));' "$readiness_policy" \
      >/dev/null 2>&1; then
      ready=1
      break
    fi
    [[ "$attempt" -eq 30 ]] || sleep 2
  done
  if [[ "$ready" -ne 1 ]]; then
    echo "$MAXIM_MEDIA_ANALYSIS_SERVICE did not reach internal OCR readiness." >&2
    return 1
  fi

  if ! output="$(
    docker compose "${compose_args_ref[@]}" exec -T "$MAXIM_MEDIA_ANALYSIS_SERVICE" \
      node apps/api/dist/apps/api/src/scripts/smoke-commercial-ocr-worker.js 2>&1
  )"; then
    echo "Native OCR worker raster smoke failed in $MAXIM_MEDIA_ANALYSIS_SERVICE." >&2
    [[ -z "$output" ]] || printf '%s\n' "$output" >&2
    return 1
  fi
  if ! grep -Fxq 'Commercial OCR worker smoke passed.' <<<"$output"; then
    echo "$MAXIM_MEDIA_ANALYSIS_SERVICE did not complete the native OCR worker raster smoke." >&2
    [[ -z "$output" ]] || printf '%s\n' "$output" >&2
    return 1
  fi

  if [[ "$native_boundary_policy" == "sandbox" ]]; then
    local sandbox_container_id
    sandbox_container_id="$(
      docker compose "${compose_args_ref[@]}" ps --status running -q \
        "$MAXIM_OCR_NATIVE_SANDBOX_SERVICE" 2>/dev/null
    )" || return 1
    if [[ -z "$sandbox_container_id" || "$sandbox_container_id" == *$'\n'* ]]; then
      echo "Could not resolve the unique OCR sandbox after raster smoke." >&2
      return 1
    fi
    if ! maxim_topology_wait_for_no_ocr_native_processes "$sandbox_container_id" 15; then
      echo "OCR sandbox retained a Tesseract process after raster smoke." >&2
      return 1
    fi
    echo "No-network OCR sandbox, Tesseract rus+eng, UDS raster, reviewed rollout mode, and internal OCR readiness smokes passed."
  else
    echo "Tesseract rus+eng, reviewed rollout mode, native worker raster, and internal OCR readiness smokes passed in $MAXIM_MEDIA_ANALYSIS_SERVICE."
  fi
}

maxim_topology_expand_api_services() {
  local services_var="$1"
  local reason="$2"
  # services_var intentionally names the caller's array.
  # shellcheck disable=SC2178
  local -n services_ref="$services_var"
  local service
  local added=()

  for service in "${MAXIM_PRODUCTION_API_SERVICES[@]}"; do
    if maxim_topology_contains "$service" "${services_ref[@]}"; then
      continue
    fi
    services_ref+=("$service")
    added+=("$service")
  done

  if [[ "${#added[@]}" -gt 0 ]]; then
    echo "$reason Expanding deploy target to every shared API role: ${MAXIM_PRODUCTION_API_SERVICES[*]}"
  fi
}

maxim_topology_refuse_dirty_api_build_inputs() {
  local dirty_inputs_path
  local ignored_inputs_path
  local ignored_file
  local unsafe_ignored_input=0

  if ! dirty_inputs_path="$(mktemp)"; then
    echo "Could not create the API build-input preflight snapshot." >&2
    return 1
  fi
  if ! ignored_inputs_path="$(mktemp)"; then
    rm -f "$dirty_inputs_path"
    echo "Could not create the ignored API build-input preflight snapshot." >&2
    return 1
  fi
  if ! git status --porcelain=v1 --untracked-files=all -- \
    .dockerignore \
    package.json \
    package-lock.json \
    tsconfig.base.json \
    apps/admin/package.json \
    apps/api \
    apps/miniapp/package.json \
    packages/contracts \
    scripts \
    infra/certs \
    infra/scripts/outcome-cohort-online-state.mjs >"$dirty_inputs_path"; then
    rm -f "$dirty_inputs_path" "$ignored_inputs_path"
    echo "Could not inspect API Docker build inputs against HEAD." >&2
    return 1
  fi
  if git ls-files --others --ignored --exclude-standard -z -- \
    apps/api \
    packages/contracts \
    scripts \
    infra/certs \
    infra/scripts/outcome-cohort-online-state.mjs >"$ignored_inputs_path"; then
    while IFS= read -r -d '' ignored_file; do
      case "$ignored_file" in
        */node_modules/* | */dist/* | */coverage/* | apps/api/src/generated/* | *.log | *.env | */.env.* | *.codex-backup-*)
          ;;
        *)
          if [[ "$unsafe_ignored_input" -eq 0 ]]; then
            echo "Refusing shared API image build with Git-ignored inputs included by Docker:" >&2
          fi
          printf '  %q\n' "$ignored_file" >&2
          unsafe_ignored_input=1
          ;;
      esac
    done <"$ignored_inputs_path"
  else
    rm -f "$dirty_inputs_path" "$ignored_inputs_path"
    echo "Could not inspect ignored API Docker build inputs." >&2
    return 1
  fi
  rm -f "$ignored_inputs_path"

  if [[ -s "$dirty_inputs_path" ]]; then
    echo "Refusing shared API image build with Docker inputs that differ from HEAD:" >&2
    sed 's/^/  /' "$dirty_inputs_path" >&2
  fi
  if [[ ! -s "$dirty_inputs_path" && "$unsafe_ignored_input" -eq 0 ]]; then
    rm -f "$dirty_inputs_path"
    return 0
  fi
  rm -f "$dirty_inputs_path"
  echo "Commit, restore, remove, or add a reviewed Docker exclusion before building the production API image." >&2
  return 1
}

maxim_topology_build_shared_api_image() {
  local image_ref="$1"
  local expected_revision="${2:-}"
  local image_labels
  local source_image
  local service

  if [[ -z "$image_ref" ]]; then
    echo "An immutable shared API image ref is required." >&2
    return 1
  fi

  if [[ "$image_ref" != *:* && "$image_ref" != */* ]]; then
    source_image="${image_ref}-api-ingress:latest"
    maxim_topology_refuse_dirty_api_build_inputs
    echo "Building compatibility shared API image for Compose project: $source_image"
    docker buildx build --load --provenance=false -t "$source_image" -f apps/api/Dockerfile .
    for service in "${MAXIM_PRODUCTION_API_SERVICES[@]}"; do
      [[ "$service" == "api-ingress" ]] || docker tag "$source_image" "${image_ref}-${service}:latest"
    done
    return 0
  fi

  if [[ ! "$expected_revision" =~ ^[0-9a-f]{40}$ ]]; then
    echo "An expected full lowercase Git SHA is required for immutable API image: $image_ref" >&2
    return 1
  fi

  source_image="$image_ref"
  if image_labels="$(
    docker image inspect \
      --format '{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "com.maxim.release-protected"}}' \
      "$source_image" 2>/dev/null
  )"; then
    if [[ "$image_labels" != "${expected_revision}|true" ]]; then
      echo "Refusing existing immutable API image with unverified release labels: $source_image ($image_labels)" >&2
      return 1
    fi
    echo "Reusing existing immutable API image: $source_image"
    return 0
  fi
  echo "Building one shared API image without BuildKit provenance: $source_image"
  maxim_topology_refuse_dirty_api_build_inputs
  docker buildx build --load --provenance=false \
    --label "org.opencontainers.image.revision=$expected_revision" \
    --label com.maxim.release-protected=true \
    -t "$source_image" -f apps/api/Dockerfile .
}

maxim_topology_require_max_api_metrics_minute_reader() {
  local commit_sha="$1"
  local counter_source consumer_source key_source
  # FLAG: Once six-hour minute counters are written, a rollback must retain readers
  # of that state even if writers are subsequently switched back to legacy.
  if ! counter_source="$(git show "${commit_sha}:apps/api/src/max/max-api-counter-storage.ts" 2>/dev/null)" ||
    ! consumer_source="$(git show "${commit_sha}:apps/api/src/system/max-api-metrics.service.ts" 2>/dev/null)" ||
    ! key_source="$(git show "${commit_sha}:apps/api/src/max/max-api-metrics-key.util.ts" 2>/dev/null)"; then
    echo "Rollback target predates the MAX API minute metric reader." >&2
    return 1
  fi
  if ! printf '%s\0%s\0%s' "$counter_source" "$consumer_source" "$key_source" | node -e '
    const input = require("node:fs").readFileSync(0);
    if (input.byteLength < 1 || input.byteLength > 4 * 1024 * 1024) process.exit(1);
    const parts = input.toString("utf8").split("\0");
    if (parts.length !== 3) process.exit(1);
    const [counter, consumer, keys] = parts;
    const valid =
      /export const MAX_API_METRICS_MINUTE_READER_VERSION\s*=\s*1\s*;/u.test(counter) &&
      /export async function readMaxApiMetricCounts\s*\(/u.test(counter) &&
      counter.includes("MAX_API_METRICS_MINUTE_READER_VERSION !== 1") &&
      counter.includes("await redis.mget(...chunk)") &&
      counter.includes("pipeline.hmget(key, ...entries.map((entry) => entry.field))") &&
      counter.includes("counts.set(entry.legacyKey, (counts.get(entry.legacyKey) ?? 0) + count)") &&
      /import\s*\{[^}]*readMaxApiMetricCounts[^}]*\}\s*from\s*\x27\.\.\/max\/max-api-counter-storage\x27/u.test(consumer) &&
      /private async readCounts\([^)]*\)[^{]*\{\s*return readMaxApiMetricCounts\(this\.redis, keys\);\s*\}/u.test(consumer) &&
      /const counts = await readMaxApiMetricCounts\(\s*this\.redis,\s*currentBatch\.map\(\(entry\) => entry\.key\)/u.test(consumer) &&
      consumer.includes("MAX_API_SOURCE_MINUTE_METRICS_KEY_PREFIX") &&
      keys.includes("maxApiLegacyCounterMinute(key)") &&
      /MAX_API_SOURCE_MINUTE_METRICS_KEY_PREFIX\s*=\s*\x27maxapi:rps:source:v2\x27/u.test(keys);
    process.exit(valid ? 0 : 1);
  ' >/dev/null 2>&1; then
    echo "Rollback target lacks the wired MAX API minute metric reader." >&2
    return 1
  fi
}

maxim_topology_require_commercial_ai_delete_guard() {
  local commit_sha="$1" source_path source
  # FLAG: Pending AI reasons retain their own reader floor even after the mode is disabled.
  # Old executors must never treat an unknown AI reason as unguarded deletion authority.
  for source_path in \
    apps/api/src/moderation/commercial/commercial-llm-enforcement.protocol.ts \
    apps/api/src/moderation/commercial/commercial-llm-delete-guard.service.ts \
    apps/api/src/moderation/commercial/commercial-llm-effect-origin.ts \
    apps/api/src/moderation/moderation-delete-intent.service.ts; do
    source="$(git show "${commit_sha}:${source_path}" 2>/dev/null)" || {
      echo 'Rollback target predates guarded commercial AI deletion.' >&2; return 1;
    }
    # FLAG: The JavaScript parser matches quote literals, including backticks, without shell expansion.
    # shellcheck disable=SC2016
    if ! printf '%s' "$source" | node -e '
      const source = require("node:fs").readFileSync(0).toString("utf8");
      const path = process.argv[1];
      if (source.length > 2 * 1024 * 1024) process.exit(1);
      const required = path.endsWith("enforcement.protocol.ts")
        ? ["COMMERCIAL_LLM_DELETE", "COMMERCIAL_LLM_EFFECT_MAX_AGE_MS = 60_000", "classifierSha256", "sourceWebhookEventId"]
        : path.endsWith("delete-guard.service.ts")
          ? ["CommercialLlmDeleteGuardService", "hasProof(source)", "getExactMessageRow(", "commercialLlmSourceCurrent(source)", "settingsSha256"]
          : path.endsWith("effect-origin.ts")
            ? ["withCommercialLlmEffectOrigin", "readCommercialLlmEffectOrigin", "scope.active = false", "await hasProof()"]
            : ["commercialLlmGuard!.authorize(", "Commercial AI guard unavailable", "CommercialLlmGuardRejectedError", "readCommercialLlmEffectOrigin(", "verifiedReasonDeadlines"];
      let deadlineFlow = true;
      if (path.endsWith("moderation-delete-intent.service.ts")) {
        const clean = source.replace(/("(?:\\.|[^"\\])*"|\u0027(?:\\.|[^\u0027\\])*\u0027|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu,
          (match, literal) => literal ?? "");
        const marker = "private async authorizeGuardedUserDeleteReasons(";
        const start = clean.indexOf(marker);
        const end = clean.indexOf("\n  private ", start + 1);
        const reasons = start >= 0 && end > start ? clean.slice(start, end).replace(/\s+/gu, " ") : "";
        const legacy = reasons.match(/independentAuthorityDeadlineAtMs: independentWithoutShortDeadline \? null : ([A-Za-z_$][\w$]*) \|\| null/u);
        const prepared = reasons.match(/independentAuthorityDeadlineAtMs: unboundedIndependent \? null : ([A-Za-z_$][\w$]*) \|\| null/u);
        const accumulator = (match) => match && reasons.includes("let " + match[1] + " = 0;") &&
          reasons.includes(match[1] + " = Math.max(");
        const snapshotStart = reasons.indexOf("for (const permit of candidate.authoritySnapshot?.deadlines ?? []) {");
        const snapshotEnd = reasons.indexOf("const permits =", snapshotStart);
        const snapshot = reasons.slice(snapshotStart, snapshotEnd);
        const currentStart = reasons.indexOf("for (const permit of currentPermits) {");
        const current = reasons.slice(currentStart, snapshotStart);
        // FLAG: A local continuation may only retain original keys and intersect
        // original deadlines. It must not renew a permit or introduce a new reason.
        const preparedFlow = accumulator(prepared) &&
          reasons.includes(prepared[1] + " = Math.max(" + prepared[1] + ", deadline);") &&
          reasons.includes("await prepare(() => deferred ? this.commercialLlmGuard!.prepareForDispatch({ ...params, reasons }) : this.commercialLlmGuard!.authorize({ ...params, reasons }), );") &&
          reasons.includes("const result = await finalizeDeleteAuthority(candidate.preparation);") &&
          reasons.includes("const keys = candidate.authoritySnapshot ? preparedKeys.filter((key) => candidate.authoritySnapshot!.keys.includes(key)) : preparedKeys;") &&
          reasons.includes("if (candidate.authoritySnapshot?.keys.length && !keys.length) throw new ModerationDeleteReasonsRejectedError(fingerprint);") &&
          currentStart >= 0 && snapshotStart > currentStart &&
          current.includes("if (keys.includes(permit.reasonKey)) boundedDeadlines.set( permit.reasonKey, Math.min(boundedDeadlines.get(permit.reasonKey) ?? Infinity, permit.deadlineAtMs), );") &&
          snapshotStart >= 0 && snapshotEnd > snapshotStart &&
          snapshot.includes("if (keys.includes(permit.reasonKey)) boundedDeadlines.set( permit.reasonKey, Math.min(boundedDeadlines.get(permit.reasonKey) ?? Infinity, permit.deadlineAtMs), );") &&
          reasons.includes("deadline = Math.min(deadline ?? Infinity, candidate.authoritySnapshot.deadlineAtMs);") &&
          reasons.includes("authoritySnapshot: { keys, deadlineAtMs: deadline, deadlines: permits },") &&
          reasons.includes("for (const permit of permits) { verifiedReasonDeadlines.set( permit.reasonKey, Math.min( verifiedReasonDeadlines.get(permit.reasonKey) ?? Infinity, permit.deadlineAtMs, ), ); }") &&
          reasons.includes("verifiedReasonDeadlines: [...verifiedReasonDeadlines].map(([reasonKey, deadlineAtMs]) => ({ reasonKey, deadlineAtMs, })),") &&
          reasons.includes("independentRecheck: prepareDeleteAuthority(async () => finalizeCandidates( independentCandidates.map((candidate) => ({ ...candidate, preparation: prepareDeleteAuthorityRecheck(candidate.preparation), })), false, ), ),") &&
          reasons.includes("return finalizeCandidates(candidates, true);");
        const legacyAiStart = reasons.indexOf("if (reasons.some((reason) => reason.ruleCode === COMMERCIAL_LLM_DELETE_RULE_CODE)) {");
        const legacyAiEnd = reasons.indexOf("if (reasons.some(", legacyAiStart + 1);
        const legacyAi = reasons.slice(legacyAiStart, legacyAiEnd > legacyAiStart ? legacyAiEnd : undefined)
          .replace(/\s+/gu, "").replace(/,\)/gu, ")");
        const legacyFlow = accumulator(legacy) && legacyAiStart >= 0 &&
          legacyAi.includes("constpermit=awaitcheck(()=>this.commercialLlmGuard!.authorize({...params,reasons}));") &&
          legacyAi.includes(legacy[1] + "=Math.max(" + legacy[1] + ",Number(permit.deadlineAtMs));") &&
          reasons.includes("verifiedReasonDeadlines: [...verifiedReasonDeadlines]");
        deadlineFlow = clean.split(marker).length === 2 &&
          (reasons.includes("const candidates: Candidate[] = [];") ? preparedFlow : legacyFlow);
      }
      process.exit(required.every(marker => source.includes(marker)) && deadlineFlow ? 0 : 1);
    ' "$source_path"; then
      echo 'Rollback target lacks the commercial AI source/proof/deadline guard.' >&2; return 1
    fi
  done
}

maxim_topology_require_commercial_ai_pool_delete_reader() {
  local commit_sha="$1" source
  maxim_topology_require_commercial_ai_delete_guard "$commit_sha" || return
  # FLAG: Issued v2 pool sources outlive routing flags. Rollback must retain both the old
  # v1 reader and the policy-bound v2 reader; disabling or draining the pool lowers no floor.
  source="$(git show "${commit_sha}:apps/api/src/moderation/commercial/commercial-llm-enforcement.protocol.ts" 2>/dev/null)" || return
  if ! printf '%s' "$source" | node -e '
    const source = require("node:fs").readFileSync(0).toString("utf8");
    if (source.length > 2 * 1024 * 1024) process.exit(1);
    const required = [
      "COMMERCIAL_LLM_ENFORCEMENT_VERSION = 1",
      "legacyCommercialLlmSourceSchema",
      "commercialLlmSourceSchema = z.union(",
      "commercialLlmPoolEnforcementIdentity",
      "commercial-pool-v2",
      "version: z.literal(2)",
      "poolPolicy: z.literal("
    ];
    process.exit(required.every(marker => source.includes(marker)) ? 0 : 1);
  '; then
    echo 'Rollback target lacks the compatible commercial AI v1/v2 pool source reader.' >&2
    return 1
  fi
}

# FLAG: Installed Lastik ownership survives a disabled flag; rollback must retain its final fence.
maxim_topology_require_eraser_bridge() {
  local source_sha="$1"
  local marker=/var/lib/maxim-deploy/eraser-reader-version
  [[ -e "$marker" || -L "$marker" || -s /var/lib/maxim-secrets/eraser.env || \
     -e /var/lib/maxim-deploy/eraser-connection-request-version || -L /var/lib/maxim-deploy/eraser-connection-request-version ]] || return 0
  if [[ -e "$marker" || -L "$marker" ]]; then
    if [[ ! -f "$marker" || -L "$marker" || "$(stat -c '%s' "$marker")" != 2 || "$(cat "$marker")" != 1 ]]; then
      echo 'Installed Lastik ownership reader floor is unknown.' >&2; return 1
    fi
  fi
  node infra/scripts/assert-eraser-source.mjs "$source_sha" || return
  maxim_topology_require_eraser_connection_requests "$source_sha" all
}

# FLAG: A disabled flag or empty pending queue never lowers the installed connection reader floor.
maxim_topology_require_eraser_connection_requests() {
  local source_sha="$1" component="${2:-all}"
  local marker=/var/lib/maxim-deploy/eraser-connection-request-version
  [[ -e "$marker" || -L "$marker" ]] || return 0
  node infra/scripts/assert-eraser-source.mjs "$source_sha" --validate-connection-request-floor || return
  node infra/scripts/assert-eraser-source.mjs "$source_sha" --connection-requests "$component"
}

# FLAG: The scoped SEND reader floor persists after flags are disabled or chats unbound.
maxim_topology_require_karavan_marketplaces() {
  node infra/scripts/assert-karavan-marketplace-source.mjs "$1"
}

# FLAG: Token cooldown state belongs only to Lastik; API image rollback does not read it.
maxim_topology_require_eraser_rate_limit_reader() {
  local source_sha="$1" component="${2:-all}"
  local marker=/var/lib/maxim-deploy/eraser-rate-limit-reader-version
  [[ -e "$marker" || -L "$marker" ]] || return 0
  node infra/scripts/assert-eraser-source.mjs "$source_sha" --validate-rate-limit-reader-floor || return
  node infra/scripts/assert-eraser-source.mjs "$source_sha" --rate-limit-reader "$component"
}
