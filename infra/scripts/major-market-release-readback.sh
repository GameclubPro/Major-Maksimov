#!/usr/bin/env bash
set -euo pipefail
# FLAG: Read-only owner checks; no deploy, migration, queue mutation or MAX publication.
ROOT_DIR=/var/www/Chat_bot
cd "$ROOT_DIR"
target="${1:-}"; selected=",${2:-},"
api_image_id="${3:-}"
[[ "$#" == 3 && "$target" =~ ^[a-f0-9]{40}$ && "$api_image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 2
# shellcheck source=infra/scripts/lib/deploy-topology.sh
source infra/scripts/lib/deploy-topology.sh
COMPOSE_FILES=(--env-file "$ROOT_DIR/.env" -p infra -f "$ROOT_DIR/infra/docker-compose.yml")
smoke() { timeout --foreground --kill-after=5s 30s node scripts/smoke-http.mjs "$@"; }
if [[ "$selected" == *,api-shared,* ]]; then
  TARGET_HAS_MEDIA_ANALYSIS=0; TARGET_COMMERCIAL_OCR_VERSION=''; TARGET_HAS_OCR_NATIVE_SANDBOX=0
  maxim_topology_prepare_commercial_ocr_target "$target" COMPOSE_FILES TARGET_HAS_MEDIA_ANALYSIS TARGET_COMMERCIAL_OCR_VERSION TARGET_HAS_OCR_NATIVE_SANDBOX
  maxim_topology_prepare_photo_native_target "$target" COMPOSE_FILES
  maxim_topology_verify_api_commercial_ocr_version COMPOSE_FILES "$TARGET_COMMERCIAL_OCR_VERSION"
  [[ "$TARGET_HAS_MEDIA_ANALYSIS" == 1 && "$TARGET_HAS_OCR_NATIVE_SANDBOX" == 1 && "$MAXIM_TARGET_HAS_PHOTO_NATIVE_SANDBOX" == 1 ]] || exit 1
  maxim_topology_verify_ocr_native_sandbox_runtime COMPOSE_FILES "$api_image_id" with-media
  maxim_topology_verify_photo_native_sandbox_for_image COMPOSE_FILES "$api_image_id"
  maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES required sandbox
  maxim_topology_smoke_photo_native_sandbox_uds COMPOSE_FILES "$api_image_id"
  for url in http://127.0.0.1:3001/api/health/live http://127.0.0.1:3001/api/health/ready http://127.0.0.1:3002/api/health/live http://127.0.0.1:3002/api/health/ready https://major-maksimov.ru/api/health/live; do smoke json-ok "$url"; done
  status="$(timeout --foreground --kill-after=5s 30s docker compose "${COMPOSE_FILES[@]}" exec -T api-admin node - status <infra/scripts/webhook-queue-rollout-control.cjs)"
  printf '%s' "$status" | node -e 'let s="";process.stdin.on("data",b=>s+=b);process.stdin.on("end",()=>{const d=JSON.parse(s);process.exit(d.queueCount===24&&d.pausedCount===0&&Number.isSafeInteger(d.activeCount)&&d.activeCount>=0&&d.ownerPresent===false?0:1)})'
  timeout --foreground --kill-after=2s 15s docker compose "${COMPOSE_FILES[@]}" exec -T postgres pg_isready -U maxim -d maxim >/dev/null
  timeout --foreground --kill-after=2s 15s docker compose "${COMPOSE_FILES[@]}" exec -T redis redis-cli ping | grep -Fxq PONG
fi
if [[ "$selected" == *,miniapp-major-static,* ]]; then
  smoke static http://127.0.0.1:3003/app/
  smoke static https://major-maksimov.ru/app/
fi
if [[ "$selected" == *,admin-static,* ]]; then smoke static http://127.0.0.1:3004/; fi
if [[ "$selected" == *,eraser,* ]]; then
  # shellcheck source=infra/scripts/lib/eraser-deploy.sh
  source infra/scripts/lib/eraser-deploy.sh
  maxim_eraser_smoke "$target"
fi
