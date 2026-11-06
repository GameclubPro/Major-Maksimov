#!/usr/bin/env bash
set -euo pipefail
export GIT_NO_REPLACE_OBJECTS=1
# FLAG: Reviewed tooling bootstrap only. Market archives/current runtime remain immutable.
MAJOR_ROOT=/var/www/Chat_bot
MARKET_ROOT=/var/www/svyazka
TRUST=/etc/maxim-deploy/major-market-release
MAJOR_SHA="${1:-}"
MARKET_SHA="${2:-}"
[[ "$#" == 2 && "$MAJOR_SHA" =~ ^[a-f0-9]{40}$ && "$MARKET_SHA" =~ ^[a-f0-9]{40}$ ]] || exit 2
[[ -z "${MAXIM_DEPLOY_LOCK_FD:-}${PAIR_RELEASE_ADMISSION_TOKEN:-}${MAJOR_MARKET_RELEASE_EXPECTATION_B64:-}${MAJOR_MARKET_RELEASE_EXPECTED_STATE_SHA256:-}" ]] || {
  echo 'Bootstrap must own its fresh tooling admission, without a runtime expectation.' >&2; exit 1;
}
cd "$MAJOR_ROOT"
[[ -z "$(git status --porcelain)" ]] || { echo 'Bootstrap needs clean Major source.' >&2; exit 1; }
BEFORE_SHA="$(git rev-parse HEAD)"
BEFORE_BRANCH="$(git branch --show-current)"
[[ -n "$BEFORE_BRANCH" ]] || exit 1
# shellcheck source=infra/scripts/lib/deploy-lock.sh
source infra/scripts/lib/deploy-lock.sh
DEPLOY_MODE=plan
maxim_pair_release_load
pair_release_admission_acquire major '' tooling "$MAJOR_SHA"
acquire_deploy_lock
STAGE="$(mktemp -d /tmp/major-market-guard.XXXXXXXX)"
cleanup_guard_bootstrap() {
  local status=$?
  rm -rf -- "$STAGE"
  if ((status >= 128)); then
    # FLAG: Interruption retains the existing pair owner's durable uncertainty.
    # Closing this shell's product FD never unlocks surviving inherited work.
    validate_deploy_lock_descriptor && exec {MAXIM_DEPLOY_LOCK_FD}>&-
  else
    release_deploy_lock
  fi
  return "$status"
}
trap cleanup_guard_bootstrap EXIT
require_deploy_lock
node --input-type=module - "$BASHPID" <<'NODE'
import { readdirSync, readFileSync } from 'node:fs';
const ignored = new Set([process.pid]); let pid = Number(process.argv[2]);
while (pid > 0 && !ignored.has(pid)) {
  ignored.add(pid); const raw = readFileSync(`/proc/${pid}/stat`, 'utf8'); pid = Number(raw.slice(raw.lastIndexOf(')') + 2).split(' ')[1]);
}
const names = readdirSync('/proc').filter(name => /^\d+$/u.test(name));
if (names.length > 32768) throw new Error('Process inventory budget');
for (const name of names) {
  if (ignored.has(Number(name))) continue;
  let cmd; try { cmd = readFileSync(`/proc/${name}/cmdline`, 'utf8').replaceAll('\0', ' '); }
  catch (error) { if (['ENOENT','ESRCH'].includes(error.code)) continue; throw error; }
  if (cmd.length > 1048576) throw new Error('Process argument budget');
  if (/(?:vps-(?:pull-build|runtime-rollback|release-rollback|finalize-release|preload)|deploy-vps\.sh|release-vps\.sh|docker\s+(?:build|buildx|compose\b.*\b(?:build|up|start|run)))/u.test(cmd)) throw new Error('Active incompatible release wrapper');
}
NODE
git fetch origin "$MAJOR_SHA"
[[ "$(git rev-parse "$MAJOR_SHA^{commit}")" == "$MAJOR_SHA" ]] || exit 1
git merge-base --is-ancestor "$BEFORE_SHA" "$MAJOR_SHA"
while IFS= read -r path; do
  case "$path" in
    infra/scripts/major-market-release-state.mjs|infra/scripts/major-market-release-readback.mjs|infra/scripts/major-market-release-readback.sh|infra/scripts/install-major-market-release-guard.sh|infra/scripts/major-market-release*.test.mjs|infra/scripts/test-fixtures/major-market-release.mjs|infra/scripts/lib/deploy-lock.sh|infra/scripts/vps-connect.sh|infra/scripts/vps-pull-build-up.sh|infra/scripts/vps-runtime-rollback.sh|docs/operations/runbooks/major-market-release.md|docs/development/production-operations-reference.md) ;;
    *) echo 'Bootstrap target includes application or unrelated source changes.' >&2; exit 1 ;;
  esac
done < <(git diff --name-only "$BEFORE_SHA" "$MAJOR_SHA")
git show "$MAJOR_SHA:infra/scripts/major-market-release-state.mjs" >"$STAGE/guard.mjs"
node --check "$STAGE/guard.mjs"
node "$STAGE/guard.mjs" check-source --owner major --source "$MAJOR_ROOT" --ref "$MAJOR_SHA"
node "$STAGE/guard.mjs" check-source --owner market --source "$MARKET_ROOT/releases/$MARKET_SHA"
node "$STAGE/guard.mjs" check-market-archive --target-sha "$MARKET_SHA"
[[ -f "$MARKET_ROOT/releases/$MARKET_SHA.tar" && ! -L "$MARKET_ROOT/releases/$MARKET_SHA.tar" \
  && -f "$MARKET_ROOT/releases/$MARKET_SHA.provenance.json" && ! -L "$MARKET_ROOT/releases/$MARKET_SHA.provenance.json" ]] || exit 1
require_market_statistics_lock_dispatch "$MAJOR_SHA"
require_pair_release_admission_dispatch "$MAJOR_SHA"
if declare -F require_major_market_release_dispatch >/dev/null; then require_major_market_release_dispatch "$MAJOR_SHA"; fi
GUARD_SHA="$(sha256sum "$STAGE/guard.mjs" | cut -d' ' -f1)"
for input in infra/scripts/release-readback.mjs infra/scripts/verify-release-source.mjs scripts/lib/release-provenance.mjs; do
  install -d -m 0700 "$STAGE/market-owner/${input%/*}"
  install -m 0400 "$MARKET_ROOT/releases/$MARKET_SHA/$input" "$STAGE/market-owner/$input"
done
node --input-type=module - "$STAGE" "$GUARD_SHA" "$MAJOR_SHA" "$MARKET_SHA" "$MARKET_ROOT" <<'MARKER'
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const [stage, guardSha256, majorSha, marketSha, marketRoot] = process.argv.slice(2);
const files = ['infra/scripts/release-readback.mjs','infra/scripts/verify-release-source.mjs','scripts/lib/release-provenance.mjs'];
const provenance = JSON.parse(readFileSync(`${marketRoot}/releases/${marketSha}.provenance.json`));
const marketOwnerFiles = {};
for (const file of files) {
  const bytes = readFileSync(`${stage}/market-owner/${file}`);
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (provenance.files.find(entry => entry.path === file)?.blob !== blob) throw new Error('Pinned owner file differs from committed candidate');
  marketOwnerFiles[file] = createHash('sha256').update(bytes).digest('hex');
}
writeFileSync(`${stage}/protocol-v1.json`, JSON.stringify({ schemaVersion:1, protocol:'major-market-release-v1', protocolVersion:1, guardSha256, majorSha, marketSha, marketOwnerFiles })+'\n', {mode:0o400});
MARKER
MARKER_SHA="$(sha256sum "$STAGE/protocol-v1.json" | cut -d' ' -f1)"
[[ "$(git rev-parse HEAD)" == "$BEFORE_SHA" && "$(git branch --show-current)" == "$BEFORE_BRANCH" && -z "$(git status --porcelain)" ]] || exit 1
# FLAG: Source capability is installed before enabling the protected protocol marker.
git -c core.hooksPath=/dev/null merge --ff-only "$MAJOR_SHA"
[[ "$(git rev-parse HEAD)" == "$MAJOR_SHA" && -z "$(git status --porcelain)" ]] || exit 1
sudo -n bash -s -- "$STAGE" "$TRUST" "$GUARD_SHA" "$MARKER_SHA" <<'ROOT'
set -euo pipefail
stage="$1"; trusted="$2"; expected="$3"; expected_marker="$4"
[[ "$EUID" == 0 && "$stage" =~ ^/tmp/major-market-guard\.[A-Za-z0-9]{8}$ && "$trusted" == /etc/maxim-deploy/major-market-release ]] || exit 1
for path in /etc /etc/maxim-deploy; do
  if [[ ! -e "$path" && ! -L "$path" && "$path" == /etc/maxim-deploy ]]; then install -d -o root -g root -m 0755 "$path"; fi
  [[ -d "$path" && ! -L "$path" ]] || exit 1
  read -r owner mode <<<"$(stat -c '%u %a' "$path")"
  [[ "$owner" == 0 && "$mode" =~ ^[0-7]{3,4}$ ]] && (( (8#$mode & 0022) == 0 )) || exit 1
done
if [[ -e "$trusted" || -L "$trusted" ]]; then
  [[ -d "$trusted" && ! -L "$trusted" && "$(stat -c '%u:%a' "$trusted")" == 0:755 ]] || exit 1
  # A changed installed implementation requires its own reviewed protocol upgrade.
  [[ -f "$trusted/guard.mjs" && ! -L "$trusted/guard.mjs" && "$(sha256sum "$trusted/guard.mjs" | cut -d' ' -f1)" == "$expected" ]] || exit 1
  node "$trusted/guard.mjs" verify-install
  for input in infra/scripts/release-readback.mjs infra/scripts/verify-release-source.mjs scripts/lib/release-provenance.mjs; do cmp -s "$stage/market-owner/$input" "$trusted/market-owner/$input"; done
  exit 0
fi
# FLAG: Publish the complete protected directory atomically; no visible half-install.
bundle="$(mktemp -d /etc/maxim-deploy/.major-market-release.XXXXXXXX)"
trap 'rm -rf -- "$bundle"' EXIT
chmod 0755 "$bundle"
for input in guard.mjs protocol-v1.json; do
  [[ -f "$stage/$input" && ! -L "$stage/$input" && "$(stat -c '%h' "$stage/$input")" == 1 ]] || exit 1
  install -o root -g root -m 0444 "$stage/$input" "$bundle/$input"
  if [[ "$input" == guard.mjs ]]; then [[ "$(sha256sum "$bundle/$input" | cut -d' ' -f1)" == "$expected" ]] || exit 1; fi
  if [[ "$input" == protocol-v1.json ]]; then [[ "$(sha256sum "$bundle/$input" | cut -d' ' -f1)" == "$expected_marker" ]] || exit 1; fi
done
for input in infra/scripts/release-readback.mjs infra/scripts/verify-release-source.mjs scripts/lib/release-provenance.mjs; do
  [[ -f "$stage/market-owner/$input" && ! -L "$stage/market-owner/$input" && "$(stat -c '%h' "$stage/market-owner/$input")" == 1 ]] || exit 1
  install -d -o root -g root -m 0755 "$bundle/market-owner/${input%/*}"
  install -o root -g root -m 0444 "$stage/market-owner/$input" "$bundle/market-owner/$input"
done
node --input-type=module - "$bundle" <<'SEAL'
import { readFileSync, openSync, closeSync, fsyncSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
const root = process.argv[2], marker = JSON.parse(readFileSync(`${root}/protocol-v1.json`));
for (const [file, expected] of Object.entries(marker.marketOwnerFiles)) {
  if (!['infra/scripts/release-readback.mjs','infra/scripts/verify-release-source.mjs','scripts/lib/release-provenance.mjs'].includes(file)) throw new Error('Unexpected owner reader');
  if (createHash('sha256').update(readFileSync(`${root}/market-owner/${file}`)).digest('hex') !== expected) throw new Error('Pinned reader changed');
}
for (const file of ['guard.mjs','protocol-v1.json', ...Object.keys(marker.marketOwnerFiles).map(file => `market-owner/${file}`), 'market-owner/infra/scripts','market-owner/infra','market-owner/scripts/lib','market-owner/scripts','market-owner','.']) {
  const fd = openSync(`${root}/${file}`, constants.O_RDONLY|constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); }
}
SEAL
mv -T -- "$bundle" "$trusted"
node -e 'const fs=require("node:fs");const fd=fs.openSync(process.argv[1],fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}' /etc/maxim-deploy
ROOT
node "$TRUST/guard.mjs" verify-install
node "$TRUST/guard.mjs" check-source --owner major --source "$MAJOR_ROOT"
node "$TRUST/guard.mjs" check-source --owner market --source "$MARKET_ROOT/releases/$MARKET_SHA"
require_deploy_lock
echo 'Major/Market guard installed; runtime, stores, current manifests and lock inode preserved.' >&2
