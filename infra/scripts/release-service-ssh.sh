#!/usr/bin/env bash
set -euo pipefail

# FLAG: The forced key has no caller-selected executable, environment, forwarding or shell.
exec /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin \
  SSH_ORIGINAL_COMMAND="${SSH_ORIGINAL_COMMAND:-}" \
  node /usr/local/lib/maxim-release/infra/scripts/release-service-gateway.mjs
