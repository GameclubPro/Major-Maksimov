#!/usr/bin/env bash
set -euo pipefail
# FLAG: One-time tooling transition only. No images, containers, queues or SQL are
# changed. The reviewed maintenance window also excludes legacy launchers which
# do not yet participate in flock. Hold BOTH protocols until source is installed.
old_sha="${1:-}"
new_sha="${2:-}"
if [[ $# != 2 || ! "$old_sha" =~ ^[0-9a-f]{40}$ || ! "$new_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'Two exact reviewed source commits are required.' >&2
  exit 2
fi
if [[ "$(git rev-parse HEAD)" != "$old_sha" || -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo 'Clean reviewed old source is required.' >&2
  exit 1
fi
if [[ -n "${MAXIM_DEPLOY_LOCK_DIR:-}${MAXIM_DEPLOY_LOCK_FD:-}${MAXIM_DEPLOY_LOCK_VERSION:-}" ]]; then
  echo 'Lock overrides or inherited operations are refused.' >&2
  exit 1
fi
transition_pair_acquired=0
release_transition_pair() {
  if [[ "$transition_pair_acquired" == 1 ]]; then pair_release_admission_release; fi
}
if [[ -e /var/lib/major-karavan-release || -L /var/lib/major-karavan-release ]]; then
  # FLAG: Even the old one-time installer must enter common admission before product locks.
  # shellcheck source=infra/scripts/lib/pair-release-admission.sh
  source /var/lib/major-karavan-release/admission.sh
  pair_release_admission_acquire major '' tooling "$new_sha"
  transition_pair_acquired=1
  trap release_transition_pair EXIT
fi
legacy=/tmp/maxim-main-deploy.lock
protected=/var/lib/maxim-deploy
if [[ -e "$legacy" || -L "$legacy" ]] || ! mkdir -m 700 "$legacy"; then
  echo 'Existing legacy operation or lock must be investigated independently.' >&2
  exit 1
fi
legacy_identity="$(stat -c '%d:%i' "$legacy")"
printf '%s\n' "$$" >"$legacy/pid"
cleanup() {
  if [[ -d "$legacy" && ! -L "$legacy" && "$(stat -c '%d:%i' "$legacy")" == "$legacy_identity" && "$(cat "$legacy/pid")" == "$$" ]]; then
    rm -- "$legacy/pid"
    rmdir -- "$legacy"
  fi
}
trap 'cleanup; release_transition_pair' EXIT
for path in /var /var/lib "$protected"; do
  [[ -d "$path" && ! -L "$path" ]] || exit 1
  read -r owner mode <<<"$(stat -c '%u %a' "$path")"
  (( (8#$mode & 0022) == 0 && (owner == 0 || owner == EUID) )) || exit 1
done
[[ "$(stat -c '%u' "$protected")" == "$EUID" ]] || exit 1
lock_file="$protected/deploy.lock"
if [[ ! -e "$lock_file" && ! -L "$lock_file" ]]; then
  (umask 077; set -o noclobber; : >"$lock_file")
fi
[[ -f "$lock_file" && ! -L "$lock_file" && "$(stat -c '%u %a %h' "$lock_file")" == "$EUID 600 1" ]] || exit 1
exec {transition_fd}<>"$lock_file"
flock -n "$transition_fd" || { echo 'Protected lock is busy.' >&2; exit 1; }
assert_no_legacy_actors() {
  node --input-type=module - "$$" <<'NODE'
import { readdirSync, readFileSync } from 'node:fs';
const ignored = new Set([process.pid]);
let pid = Number(process.argv[2]);
while (pid > 0 && !ignored.has(pid)) {
  ignored.add(pid);
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
}
const names = readdirSync('/proc').filter(name => /^\d+$/.test(name));
if (names.length > 32768) throw new Error('Process inventory budget');
for (const name of names) {
  if (ignored.has(Number(name))) continue;
  let cmd;
  try { cmd = readFileSync(`/proc/${name}/cmdline`, 'utf8').replaceAll('\0', ' '); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error; }
  if (cmd.length > 1048576) throw new Error('Process argument budget');
  if (/(?:vps-(?:pull-build|runtime-rollback|release-rollback|finalize-release|commercial-ocr|publisher-dispatch|docker-space-reclaim|retire-|recover-|preload)|backup-postgres|restore-postgres|multibot-online-supervisor|outcome-cohort-online-supervisor|legacy-cold-host|pg_dump|pg_restore|docker\s+(?:build|buildx|compose\b.*\b(?:build|up|start|run)))/u.test(cmd))
    throw new Error('An incompatible maintenance actor is present');
}
NODE
}
assert_no_legacy_actors
git fetch origin main
[[ "$(git rev-parse origin/main)" == "$new_sha" ]] || exit 1
git merge-base --is-ancestor "$old_sha" "$new_sha"
if git cat-file -e "$new_sha:infra/scripts/lib/pair-release-admission.sh" 2>/dev/null && [[ "$transition_pair_acquired" != 1 ]]; then
  echo 'Pair-aware source requires the guarded install-pair-release-admission bootstrap first.' >&2
  exit 1
fi
# FLAG: Consume the complete source so an early marker match cannot SIGPIPE Git.
# Keep pipefail: a failed producer must refuse the transition even after a match.
git show "$new_sha:infra/scripts/lib/deploy-lock.sh" | grep -F -- 'export MAXIM_DEPLOY_LOCK_VERSION=flock-v1' >/dev/null
git show "$new_sha:infra/scripts/legacy-cold-journal.mjs" >/dev/null
assert_no_legacy_actors
git merge --ff-only "$new_sha"
[[ "$(git rev-parse HEAD)" == "$new_sha" && -z "$(git status --porcelain --untracked-files=no)" ]] || exit 1
assert_no_legacy_actors
cleanup
[[ ! -e "$legacy" && ! -L "$legacy" ]] || exit 1
# shellcheck source=infra/scripts/lib/deploy-lock.sh
source infra/scripts/lib/deploy-lock.sh
export MAXIM_DEPLOY_LOCK_VERSION=flock-v1 MAXIM_DEPLOY_LOCK_OWNER_PID="$BASHPID"
export MAXIM_DEPLOY_LOCK_FD="$transition_fd"
MAXIM_DEPLOY_LOCK_IDENTITY="$(stat -c '%d:%i' "$lock_file")"
export MAXIM_DEPLOY_LOCK_IDENTITY
require_deploy_lock
printf 'Protected flock installed at exact source %s; runtime unchanged.\n' "$new_sha"
