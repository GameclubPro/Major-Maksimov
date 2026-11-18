#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ "${1:-}" != --bounded ]]; then
  # FLAG: Reserve 60s after the work deadline for at most seventeen cleanup commands,
  # each capped at 3s with SIGKILL. Cleanup stays inside the owned process group.
  exec timeout --kill-after=60s 300s bash "$0" --bounded "$@"
fi
shift
[[ "$#" -eq 1 && "$1" =~ ^maxim-api:[a-f0-9]{40}$ ]] || exit 2
[[ "${GITHUB_ACTIONS:-}" == true && "${GITHUB_SHA:-}" == "${1#maxim-api:}" ]] || exit 2
[[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" ]] || exit 2
[[ "$(docker context inspect --format '{{.Endpoints.docker.Host}}')" == unix:///var/run/docker.sock ]] || exit 2
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
[[ "$(git rev-parse HEAD)" == "$GITHUB_SHA" ]] || exit 2
image="$1"
image_id="$(docker image inspect --format '{{.Id}}' "$image")"
[[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 2
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$GITHUB_SHA" ]] || exit 2
[[ "$(docker image inspect --format '{{index .Config.Labels "com.maxim.release-protected"}}' "$image")" == true ]] || exit 2
fixture_dir="$(mktemp -d)"
owner="outcome-client-ci-${BASHPID}-${RANDOM}"
project="multibot_ci_$(node -p 'require("node:crypto").randomUUID().replaceAll("-", "")')"
good_tag="maxim-online-$(node -p 'require("node:crypto").randomUUID()')"
cancel_tag="maxim-online-$(node -p 'require("node:crypto").randomUUID()')"
resolver_tag="maxim-online-$(node -p 'require("node:crypto").randomUUID()')"
routing_bootstrap_tag="maxim-online-$(node -p 'require("node:crypto").randomUUID()')"
routing_tag="maxim-online-$(node -p 'require("node:crypto").randomUUID()')"
attempt_owned=0
inspect_ci_object() {
  local kind="$1" object="$2" format="$3" result
  if result="$(timeout --signal=KILL 3s docker "$kind" inspect --format "$format" "$object" 2>/dev/null)"; then
    printf '%s\n' "$result"
    return 0
  fi
  # FLAG: Failed inspection is not proof of absence. A successful exact-name list
  # may prove absence; daemon, timeout and malformed/present results fail closed.
  if [[ "$kind" == container ]]; then
    result="$(timeout --signal=KILL 3s docker container ls --all --filter "name=^/${object}$" --format '{{.Names}}' 2>/dev/null)" || return 2
  else
    result="$(timeout --signal=KILL 3s docker network ls --filter "name=^${object}$" --format '{{.Name}}' 2>/dev/null)" || return 2
  fi
  [[ -z "$result" ]] || return 2
  return 3
}
cleanup() {
  local status=$? cleanup_failed=0 object label id inspect_status
  local ids=()
  local clients=("$good_tag" "$cancel_tag" "$resolver_tag" "$routing_bootstrap_tag" "$routing_tag")
  trap '' INT TERM
  echo OUTCOME_COHORT_CLIENT_CI_CLEANUP_PENDING >&2
  if [[ "$attempt_owned" -eq 1 ]]; then
    # FLAG: UUID client names were proven absent before this invocation. PostgreSQL
    # and both isolated networks are removed only with this invocation's owner label.
    for object in "${clients[@]}"; do
      if inspect_ci_object container "$object" '{{.Id}}' >/dev/null; then
        timeout --signal=KILL 3s docker rm -f "$object" >/dev/null 2>&1 || cleanup_failed=1
      else
        inspect_status=$?
        [[ "$inspect_status" -eq 3 ]] || cleanup_failed=1
      fi
    done
    id="$(timeout --signal=KILL 3s docker ps -aq --no-trunc --filter "label=com.maxim.multibot-client-ci=$owner")" || cleanup_failed=1
    [[ -z "$id" ]] || mapfile -t ids <<< "$id"
    [[ "${#ids[@]}" -eq 0 ]] || timeout --signal=KILL 3s docker rm -f "${ids[@]}" >/dev/null 2>&1 || cleanup_failed=1
    for object in "${project}_default" infra_default; do
      if label="$(inspect_ci_object network "$object" '{{index .Labels "com.maxim.multibot-client-ci"}}')"; then
        if [[ "$label" == "$owner" ]]; then
          timeout --signal=KILL 3s docker network rm "$object" >/dev/null 2>&1 || cleanup_failed=1
        else
          cleanup_failed=1
        fi
      else
        inspect_status=$?
        [[ "$inspect_status" -eq 3 ]] || cleanup_failed=1
      fi
    done
  fi
  timeout --signal=KILL 3s rm -rf "$fixture_dir" || cleanup_failed=1
  if [[ "$cleanup_failed" -eq 1 ]]; then
    echo OUTCOME_COHORT_CLIENT_CI_CLEANUP_UNCONFIRMED >&2
    [[ "$status" -ne 0 ]] || status=1
  else
    echo OUTCOME_COHORT_CLIENT_CI_CLEANUP_CONFIRMED >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker info >/dev/null
for object in "$good_tag" "$cancel_tag" "$resolver_tag" "$routing_bootstrap_tag" "$routing_tag"; do
  if inspect_ci_object container "$object" '{{.Id}}' >/dev/null; then exit 1; else
    [[ "$?" -eq 3 ]] || exit 1
  fi
done
for object in "${project}_default" infra_default; do
  if inspect_ci_object network "$object" '{{.Id}}' >/dev/null; then exit 1; else
    [[ "$?" -eq 3 ]] || exit 1
  fi
done
node infra/scripts/outcome-cohort-online-client-ci-fixture.mjs compose "$fixture_dir" "$project" "$image" "$owner"
compose=(--env-file "$fixture_dir/ci.env" -p "$project" -f "$fixture_dir/compose.json" -f "$fixture_dir/overlay.json")
attempt_owned=1
docker compose "${compose[@]}" up -d --no-deps --no-build postgres >/dev/null
ready=0
for ((attempt=0; attempt<30; attempt++)); do
  # FLAG: The official image initializes through a temporary Unix-only server.
  # Prove SQL on the same authenticated service TCP route as the migration client.
  if readiness_result="$(docker compose "${compose[@]}" exec -T postgres sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -h postgres -X -v ON_ERROR_STOP=1 -U maxim -d maxim -Atq -c "SELECT 1"' \
    2>/dev/null)" && [[ "$readiness_result" == 1 ]]; then
    ready=1
    break
  fi
  sleep 1
done
[[ "$ready" -eq 1 ]] || exit 1
export MAXIM_EXPECTED_DEPLOY_SHA="$GITHUB_SHA"
node infra/scripts/outcome-cohort-online-client-ci-fixture.mjs run "$fixture_dir" "$project" "$ROOT_DIR" "$image_id" "$good_tag" "$cancel_tag" "$resolver_tag" "$routing_bootstrap_tag" "$routing_tag" "$owner"
