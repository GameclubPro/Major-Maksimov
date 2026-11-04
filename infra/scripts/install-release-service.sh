#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
mode="${1:---plan}"
expected_sha="${2:-}"
public_key_file="${3:-}"
if [[ "$mode" == --plan && $# -le 1 ]]; then
  cat <<'PLAN'
First installation only; does not start or enable the service.
Bundle: /usr/local/lib/maxim-release (root owned, independent of controller checkout)
State: /var/lib/maxim-release (private, maximadmin owned)
Control: /run/maxim-release/control.sock (dedicated maxim-release-control group)
SSH: maxim-release-gateway, one restricted forced-command ed25519 public key
Initial policy: paused; automatic releases disabled
Apply requires root, exact green main SHA, existing shared deploy locks, complete manifest,
separate read-only GHCR credential and reviewed independent backup/restore acceptance.
Git requires /etc/maxim-deploy/git-read-key and git-known-hosts, private and service-readable.
PLAN
  exit 0
fi
if [[ "$mode" != --apply || $# != 3 || ! "$expected_sha" =~ ^[a-f0-9]{40}$ || "$EUID" != 0 ]]; then
  echo 'Usage: install-release-service.sh --plan | --apply EXACT_MAIN_SHA /private/gateway.pub (root)' >&2
  exit 2
fi
[[ "$ROOT_DIR" == /var/www/Chat_bot && ! -L "$ROOT_DIR" ]] || { echo 'Installation requires the canonical controller.' >&2; exit 1; }
cd "$ROOT_DIR"
[[ "$(git rev-parse HEAD)" == "$expected_sha" && "$(git symbolic-ref --short HEAD)" == main && -z "$(git status --porcelain --untracked-files=no)" ]] || {
  echo 'Installation requires a clean exact main checkout.' >&2; exit 1;
}
[[ ! -e /usr/local/lib/maxim-release && ! -L /usr/local/lib/maxim-release && ! -e /etc/maxim-release && ! -L /etc/maxim-release && ! -e /var/lib/maxim-release && ! -L /var/lib/maxim-release ]] || {
  echo 'An installation already exists or is incomplete; inspect it before any change.' >&2; exit 1;
}
node_binary="$(readlink -e "$(command -v node)")"
[[ "$node_binary" == /usr/bin/node || "$node_binary" == /usr/local/bin/node ]] || { echo 'Node must be installed at a reviewed system path.' >&2; exit 1; }
[[ "$(stat -c %u "$node_binary")" == 0 ]] || exit 1
node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$expected_sha" --purpose production
node "$ROOT_DIR/infra/scripts/release-manifest.mjs" validate-current >/dev/null
node -e 'if(Number(process.versions.node.split(".")[0])!==24)process.exit(1)'
runuser -u maximadmin -- node --input-type=module -e 'import {privateBytes} from "./infra/scripts/release-service-boundary.mjs"; const c=JSON.parse(privateBytes("/etc/maxim-deploy/ghcr-read.json")); if(!c.username||!c.token)process.exit(1); privateBytes("/etc/maxim-deploy/git-read-key",{maxBytes:16384}); privateBytes("/etc/maxim-deploy/git-known-hosts",{maxBytes:65536});'
# FLAG: Git reads through a fixed SSH transport outside protected home directories.
# Verify repository read access and pinned host trust as the actual service user.
git_probe="$(runuser -u maximadmin -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/var/lib/maxim-release \
  GIT_TERMINAL_PROMPT=0 GIT_NO_REPLACE_OBJECTS=1 \
  GIT_SSH_COMMAND='/bin/bash /var/www/Chat_bot/infra/scripts/release-service-git-ssh.sh' \
  timeout --signal=TERM --kill-after=2 30 /usr/bin/git ls-remote --exit-code git@github.com:GameclubPro/Major-Maksimov.git refs/heads/main)"
[[ "$git_probe" == "$expected_sha"$'\trefs/heads/main' ]] || { echo 'Service Git readback did not prove exact main.' >&2; exit 1; }
# FLAG: Installation preserves the separate recovery gate. This receipt is reviewed and installed
# by the existing backup acceptance procedure, never inferred from timers or one successful dump.
[[ -f /etc/maxim-release-recovery-accepted.json && ! -L /etc/maxim-release-recovery-accepted.json ]] || {
  echo 'Independent main backup/readback and isolated restore acceptance receipt is required.' >&2; exit 1;
}
node --input-type=module -e '
import {privateBytes} from "./infra/scripts/release-service-boundary.mjs";
const r=JSON.parse(privateBytes("/etc/maxim-release-recovery-accepted.json"));
const hashes=[r.backupEvidenceSha256,r.independentReadbackEvidenceSha256,r.isolatedRestoreEvidenceSha256];
if(r.schemaVersion!==1||r.profile!=="main"||!hashes.every(x=>/^[a-f0-9]{64}$/.test(x))||!Number.isFinite(Date.parse(r.acceptedAt))||Date.parse(r.acceptedAt)>Date.now()+120000||Date.parse(r.acceptedAt)<Date.now()-86400000)process.exit(1);'
[[ -f "$public_key_file" && ! -L "$public_key_file" && "$(stat -c %s "$public_key_file")" -lt 4096 ]] || exit 1
read -r key_type key_material _key_comment <"$public_key_file"
[[ "$key_type" == ssh-ed25519 && "$key_material" =~ ^[A-Za-z0-9+/=]+$ && "$(wc -l <"$public_key_file")" -eq 1 ]] || {
  echo 'Expected one plain ed25519 public key without SSH options.' >&2; exit 1;
}
ssh-keygen -l -f "$public_key_file" >/dev/null
getent passwd maximadmin >/dev/null
if getent passwd maxim-release-gateway >/dev/null || getent group maxim-release-control >/dev/null; then
  echo 'Reserved gateway user/group already exists; refusing to adopt unknown identities.' >&2; exit 1
fi
# shellcheck source=infra/scripts/lib/deploy-lock.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"
acquire_deploy_lock
trap release_deploy_lock EXIT
# FLAG: The checks above can wait on network evidence. Bind every installation input
# again under the shared lock before creating identities, directories or a service unit.
[[ "$(git rev-parse HEAD)" == "$expected_sha" && "$(git symbolic-ref --short HEAD)" == main && -z "$(git status --porcelain --untracked-files=no)" ]] || exit 1
[[ ! -e /usr/local/lib/maxim-release && ! -L /usr/local/lib/maxim-release && ! -e /etc/maxim-release && ! -L /etc/maxim-release && ! -e /var/lib/maxim-release && ! -L /var/lib/maxim-release ]] || exit 1
node "$ROOT_DIR/infra/scripts/release-manifest.mjs" validate-current >/dev/null
groupadd --system maxim-release-control
useradd --system --gid maxim-release-control --home-dir /var/lib/maxim-release-gateway --shell /bin/sh maxim-release-gateway
install -d -o root -g root -m 0755 /usr/local/lib/maxim-release /etc/maxim-release
install -d -o maximadmin -g maxim-release-control -m 0700 /var/lib/maxim-release /var/lib/maxim-release/operations
install -d -o maximadmin -g maxim-release-control -m 0700 /var/www/Chat_bot/.release-executors
install -d -o root -g root -m 0755 /var/lib/maxim-release-gateway
install -d -o root -g root -m 0755 /var/lib/maxim-release-gateway/.ssh
# FLAG: Export committed files only. Private credentials, env files and working copies never enter the bundle.
git archive "$expected_sha" scripts infra/scripts infra/systemd | tar -x -C /usr/local/lib/maxim-release
chown -R root:root /usr/local/lib/maxim-release
chmod -R go-w /usr/local/lib/maxim-release
chmod 0755 /usr/local/lib/maxim-release/infra/scripts/release-service-ssh.sh
chmod 0755 /usr/local/lib/maxim-release/infra/scripts/release-service-git-ssh.sh
printf 'restrict,command="/usr/local/lib/maxim-release/infra/scripts/release-service-ssh.sh" ssh-ed25519 %s maxim-release\n' "$key_material" > /var/lib/maxim-release-gateway/.ssh/authorized_keys
chmod 0644 /var/lib/maxim-release-gateway/.ssh/authorized_keys
runuser -u maximadmin -- node --input-type=module -e 'import {initializePolicy} from "/usr/local/lib/maxim-release/infra/scripts/release-service-policy.mjs"; initializePolicy({directory:"/var/lib/maxim-release"});'
sed "s|@NODE@|$node_binary|g" /usr/local/lib/maxim-release/infra/systemd/maxim-release.service > /etc/systemd/system/maxim-release.service
chmod 0644 /etc/systemd/system/maxim-release.service
printf '%s\n' "$expected_sha" > /etc/maxim-release/installed
chmod 0644 /etc/maxim-release/installed
systemctl daemon-reload
echo 'Installed paused service and restricted key. Service remains stopped; review inventory before explicit start/resume.'
