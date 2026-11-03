#!/usr/bin/env bash

# FLAG: Lastik is an optional independent image, never a shared API role or a store target.
maxim_eraser_configured() {
  [[ -s "${MAXIM_ERASER_ENV_FILE:-/var/lib/maxim-secrets/eraser.env}" ]]
}

# FLAG: Install before migrations or either application's new writers can start; never remove it.
maxim_eraser_install_connection_request_floor() {
  local source_sha="$1"
  maxim_eraser_configured || return 0
  node infra/scripts/assert-eraser-source.mjs "$source_sha" --install-connection-request-floor
}

# FLAG: Only Lastik writes token cooldowns; install its permanent floor before migration/start.
maxim_eraser_install_rate_limit_reader_floor() {
  local source_sha="$1"
  maxim_eraser_configured || return 0
  node infra/scripts/assert-eraser-source.mjs "$source_sha" --install-rate-limit-reader-floor
}

# FLAG: Install after compatible tooling reload, before migration or either positive writer.
maxim_eraser_install_connection_proof_reader_floor() {
  local source_sha="$1"
  maxim_eraser_configured || return 0
  node infra/scripts/assert-eraser-source.mjs "$source_sha" --install-connection-proof-reader-floor
}

maxim_eraser_require_secrets() {
  local path mode
  for path in "${MAXIM_ERASER_ENV_FILE:-/var/lib/maxim-secrets/eraser.env}" \
      "${MAXIM_ERASER_POSTGRES_PASSWORD_FILE:-/var/lib/maxim-secrets/eraser-postgres-password}"; do
    [[ -f "$path" && ! -L "$path" ]] || { echo 'Lastik secret is missing or unsafe.' >&2; return 1; }
    mode="$(stat -c '%a' "$path")" || return 1
    [[ "$mode" == 600 ]] || { echo 'Lastik secrets require mode 0600.' >&2; return 1; }
  done
}

maxim_eraser_require_stores() {
  local compose_var="$1" path service container volume expected_device
  local -n eraser_compose="$compose_var"
  maxim_eraser_require_secrets || return
  mountpoint -q /mnt/maxim-cold || { echo 'Lastik cold storage mount is unavailable.' >&2; return 1; }
  for path in /mnt/maxim-cold/runtime/eraser/postgres /mnt/maxim-cold/runtime/eraser/redis; do
    # FLAG: Read only these fixed store paths through protected ancestors; preserve their permissions.
    if sudo -n test -d "$path" && sudo -n test ! -L "$path"; then
      continue
    fi
    echo 'Lastik store directory is not provisioned.' >&2
    return 1
  done
  for volume in infra_eraser_postgres_data infra_eraser_redis_data; do
    case "$volume" in
      infra_eraser_postgres_data) expected_device=/mnt/maxim-cold/runtime/eraser/postgres ;;
      infra_eraser_redis_data) expected_device=/mnt/maxim-cold/runtime/eraser/redis ;;
    esac
    [[ "$(docker volume inspect --format '{{.Driver}}|{{index .Options "device"}}|{{index .Options "o"}}' "$volume")" == "local|$expected_device|bind" ]] || {
      echo 'Lastik store volume identity drifted.' >&2; return 1;
    }
  done
  # FLAG: Routine releases never create or recreate stores; bootstrap owns first startup.
  for service in eraser-postgres eraser-redis; do
    container="$(docker compose "${eraser_compose[@]}" ps -q "$service")" || return
    [[ -n "$container" ]] || { echo 'Lastik stores require explicit bootstrap.' >&2; return 1; }
    [[ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" == healthy ]] || {
      echo 'Lastik store is not healthy.' >&2; return 1;
    }
  done
}

maxim_eraser_refuse_dirty_build_inputs() {
  local changes
  changes="$(git status --porcelain --untracked-files=all -- apps/eraser package.json package-lock.json .dockerignore tsconfig.base.json infra/certs)" || return
  [[ -z "$changes" ]] || { echo 'Lastik Docker inputs must match the selected committed source.' >&2; return 1; }
}

maxim_eraser_smoke() {
  local expected_sha="$1"
  node infra/scripts/eraser-smoke.mjs "$expected_sha"
}
