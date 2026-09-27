#!/usr/bin/env bash
# Temporary lab VM on GCP. Cheap (e2-small ≈ $13/month), delete when done.
#   bash scripts/gcp-lab-vm.sh create|ssh|bootstrap|tunnel|delete
set -euo pipefail
PROJECT=${SAR_GCP_PROJECT:-project-e7960d87-a0b0-406b-a2f}
ZONE=${SAR_GCP_ZONE:-us-central1-a}
NAME=${SAR_GCP_VM:-sar-lab-1}
MACHINE=${SAR_GCP_MACHINE:-e2-small}
g() { gcloud --project "$PROJECT" "$@"; }

# Shared machine: deploy only what is on origin/main. Branches are verified by the
# required `selftest-vm` CI check before merge; ad-hoc branch deploys overwrite
# each other between parallel sessions (2026-09-28). Override: SAR_DEPLOY_ANY=1.
deploy_guard() {
  [ "${SAR_DEPLOY_ANY:-0}" = 1 ] && return 0
  local repo; repo="$(dirname "$0")/.."
  git -C "$repo" fetch -q origin main
  if [ "$(git -C "$repo" rev-parse HEAD)" != "$(git -C "$repo" rev-parse origin/main)" ]; then
    echo "refusing to deploy: HEAD is not origin/main (checkout main && git pull, or SAR_DEPLOY_ANY=1)" >&2; exit 1
  fi
}

case "${1:-}" in
  create)
    g compute instances create "$NAME" --zone "$ZONE" --machine-type "$MACHINE" \
      --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud \
      --boot-disk-size 30GB --boot-disk-type pd-balanced \
      --labels purpose=sar-lab,ttl=temporary ;;
  ssh)       shift; g compute ssh "$NAME" --zone "$ZONE" -- "$@" ;;
  # Ships the committed HEAD of this checkout (works for a private repo), then bootstraps.
  bootstrap)
    deploy_guard
    git -C "$(dirname "$0")/.." archive --format=tar.gz HEAD > /tmp/sar-src.tgz
    g compute scp --zone "$ZONE" /tmp/sar-src.tgz "$NAME":/tmp/sar-src.tgz
    g compute ssh "$NAME" --zone "$ZONE" -- \
      'sudo rm -rf /tmp/sar-src && mkdir -p /tmp/sar-src && tar -xzf /tmp/sar-src.tgz -C /tmp/sar-src && sudo SAR_LOCAL_SRC=/tmp/sar-src bash /tmp/sar-src/scripts/vm-bootstrap.sh' ;;
  # Forward the API (bound to 127.0.0.1 on the VM) to localhost:8787.
  tunnel)    g compute ssh "$NAME" --zone "$ZONE" -- -N -L 8787:127.0.0.1:8787 ;;
  delete)    g compute instances delete "$NAME" --zone "$ZONE" --quiet ;;
  *) echo "usage: $0 create|ssh|bootstrap|tunnel|delete"; exit 1 ;;
esac
