#!/usr/bin/env bash
set -euo pipefail
# FLAG: Service Git transport has no dependency on an interactive home, agent or
# SSH config. Both files are separately provisioned and readable by the deploy user.
exec /usr/bin/ssh -F /dev/null -i /etc/maxim-deploy/git-read-key \
  -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes \
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/maxim-deploy/git-known-hosts \
  -o GlobalKnownHostsFile=/dev/null -o ConnectTimeout=10 \
  -o HostName=ssh.github.com -o HostKeyAlias=github.com -p 443 "$@"
