#!/usr/bin/env bash
set -euo pipefail

infra_test_args=()
case "${MAXIM_INFRA_TEST_SHARD-}" in
  '') ;;
  1/2|2/2) infra_test_args+=("--test-shard=${MAXIM_INFRA_TEST_SHARD}") ;;
  *) echo "Invalid MAXIM_INFRA_TEST_SHARD; expected 1/2 or 2/2." >&2; exit 2 ;;
esac

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

node scripts/agent/generate-deploy-impact-bash.mjs --check

while IFS= read -r -d '' script; do
  bash -n "$script"
done < <(find infra/scripts -type f -name '*.sh' -print0)

compose_validation() {
  MAXIM_COMPOSE_SERVICE_ENV_FILE=../.env.example \
    MAXIM_MIGRATION_API_IMAGE=maxim-api:infra-check \
    docker compose --env-file .env.example "$@" config --quiet
}

compose_validation -f infra/docker-compose.yml
compose_validation -f infra/docker-compose.yml -f infra/docker-compose.local.yml
compose_validation -f infra/docker-compose.yml -f infra/docker-compose.scale.yml
compose_validation -f infra/docker-compose.yml -f infra/docker-compose.runtime-no-build.yml
MAXIM_ERASER_IMAGE=maxim-eraser:infra-check compose_validation -f infra/docker-compose.yml -f infra/docker-compose.eraser-no-build.yml
compose_validation -p infra-scale -f infra/docker-compose.scale.yml -f infra/docker-compose.runtime-no-build.yml
if command -v shellcheck >/dev/null 2>&1; then
  find infra/scripts -type f -name '*.sh' -print0 | xargs -0 shellcheck
elif command -v npx >/dev/null 2>&1; then
  echo "shellcheck not installed; using pinned shellcheck@4.1.0 fallback" >&2
  mapfile -d '' -t shell_scripts < <(find infra/scripts -type f -name '*.sh' -print0)
  npx --yes --package=shellcheck@4.1.0 -- shellcheck "${shell_scripts[@]}"
else
  echo "shellcheck is required for infrastructure validation." >&2
  exit 1
fi

if command -v actionlint >/dev/null 2>&1; then
  actionlint
else
  echo "actionlint not installed; workflow lint is enforced in CI" >&2
fi

if [[ -n "${MAXIM_TEST_POSTGRES_URL:-}" ]]; then
  npm run prisma:generate --workspace @maxim/api
fi

# FLAG: Each test file may create nested native/CLI processes; bound file workers too.
node --test --test-concurrency=2 "${infra_test_args[@]}" infra/scripts/*.test.mjs
