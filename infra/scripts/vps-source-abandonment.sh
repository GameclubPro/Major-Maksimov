#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
if [[ $# != 0 || ! "${MAXIM_EXPECTED_DEPLOY_SHA:-}" =~ ^[0-9a-f]{40}$ || \
  "$(git rev-parse HEAD)" != "$MAXIM_EXPECTED_DEPLOY_SHA" ]]; then
  echo 'Source abandonment requires exact synchronized source and bounded stdin.' >&2
  exit 2
fi
# shellcheck source=infra/scripts/lib/deploy-lock.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"
acquire_deploy_lock
# FLAG: The original admission owner and inherited locks remain through stop,
# seal, readback, restart and observed controller completion.
supervise_deploy_lock_command node "$ROOT_DIR/infra/scripts/source-abandonment-host.mjs" --supervised-preflight
