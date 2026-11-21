#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
assert_cancellation_controller_source() {
  local observed_sha tree_status
  observed_sha="$(git rev-parse HEAD)" || return 2
  tree_status="$(git status --porcelain --untracked-files=normal)" || return 2
  if [[ ! "${MAXIM_EXPECTED_DEPLOY_SHA:-}" =~ ^[0-9a-f]{40}$ || "$observed_sha" != "$MAXIM_EXPECTED_DEPLOY_SHA" || -n "$tree_status" ]]; then
    echo 'Cancellation requires clean exact synchronized source.' >&2
    return 2
  fi
}
if [[ ( $# != 0 && ( $# != 1 || "$1" != --preview ) ) || \
  ( -v MAXIM_EXPECTED_BACKLOG_RUNTIME_SHA && ! "$MAXIM_EXPECTED_BACKLOG_RUNTIME_SHA" =~ ^[0-9a-f]{40}$ ) ]]; then
  echo 'Cancellation requires clean exact synchronized source.' >&2
  exit 2
fi
assert_cancellation_controller_source
# shellcheck source=infra/scripts/lib/deploy-lock.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"
# shellcheck source=infra/scripts/lib/deploy-topology.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-topology.sh"
acquire_deploy_lock
maxim_topology_require_single_ocr_for_legacy_recovery
# FLAG: A source check before waiting for the shared lock cannot attest the acquired checkout.
assert_cancellation_controller_source
supervise_deploy_lock_command node "$ROOT_DIR/infra/scripts/backlog-cancellation-host.mjs" "$@"
