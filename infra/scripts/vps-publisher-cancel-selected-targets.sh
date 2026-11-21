#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
if [[ ! "${MAXIM_EXPECTED_DEPLOY_SHA:-}" =~ ^[0-9a-f]{40}$ || \
  "$(git rev-parse HEAD)" != "$MAXIM_EXPECTED_DEPLOY_SHA" || \
  -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo 'Selected target cancellation requires clean exact reviewed tooling.' >&2
  exit 2
fi
case "${1:-}" in
  preview) [[ $# == 2 ]] || exit 2 ;;
  apply|verify) [[ $# == 3 ]] || exit 2 ;;
  *) echo 'Usage: preview request.json | apply|verify request.json preview.json' >&2; exit 2 ;;
esac
# shellcheck source=infra/scripts/lib/deploy-lock.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"
# shellcheck source=infra/scripts/lib/legacy-cold-maintenance.sh
source "$ROOT_DIR/infra/scripts/lib/legacy-cold-maintenance.sh"
# shellcheck source=infra/scripts/lib/deploy-topology.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-topology.sh"
acquire_deploy_lock
maxim_topology_require_single_ocr_for_legacy_recovery
if [[ "$1" == apply ]]; then
  maxim_require_ordinary_effect_authority "$ROOT_DIR"
fi
node "$ROOT_DIR/infra/scripts/publisher-cancel-selected-targets-host.mjs" "$@" -- \
  "${MAXIM_PRODUCTION_API_SERVICES[@]}" "$MAXIM_OCR_NATIVE_SANDBOX_SERVICE" photo-native-sandbox
