#!/usr/bin/env bash
# Manage the runtime machine over plain SSH — works with any bare Linux box.
#   SAR_SSH=root@1.2.3.4 bash scripts/machine.sh bootstrap|ssh <cmd>|tunnel|status|selftest
# For the temporary GCP lab VM, SAR_SSH may be left unset: falls back to scripts/gcp-lab-vm.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -z "${SAR_SSH:-}" ]; then exec bash scripts/gcp-lab-vm.sh "$@"; fi
SSH=(ssh -o StrictHostKeyChecking=accept-new "$SAR_SSH")

case "${1:-}" in
  bootstrap)   # ship committed HEAD (private repo friendly) and (re)deploy
    git archive --format=tar.gz HEAD | "${SSH[@]}" \
      'rm -rf /tmp/sar-src && mkdir -p /tmp/sar-src && tar -xzf - -C /tmp/sar-src && sudo SAR_LOCAL_SRC=/tmp/sar-src bash /tmp/sar-src/scripts/vm-bootstrap.sh' ;;
  ssh)      shift; "${SSH[@]}" "$@" ;;
  tunnel)   ssh -N -L 8787:127.0.0.1:8787 "$SAR_SSH" ;;
  status)   "${SSH[@]}" "sudo -u sar bash /opt/sar/scripts/dogfood-status.sh ${2:-4}" ;;
  selftest) "${SSH[@]}" "cd /opt/sar && sudo -u sar SAR_LIVE=${SAR_LIVE:-0} bash scripts/selftest.sh" ;;
  *) echo "usage: SAR_SSH=user@host $0 bootstrap|ssh <cmd>|tunnel|status [hours]|selftest"; exit 1 ;;
esac
