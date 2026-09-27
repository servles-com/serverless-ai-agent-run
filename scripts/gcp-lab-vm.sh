#!/usr/bin/env bash
# Temporary lab VM on GCP. Cheap (e2-small ≈ $13/month), delete when done.
#   bash scripts/gcp-lab-vm.sh create|ssh|bootstrap|tunnel|delete
set -euo pipefail
PROJECT=${SAR_GCP_PROJECT:-project-e7960d87-a0b0-406b-a2f}
ZONE=${SAR_GCP_ZONE:-us-central1-a}
NAME=${SAR_GCP_VM:-sar-lab-1}
MACHINE=${SAR_GCP_MACHINE:-e2-small}
g() { gcloud --project "$PROJECT" "$@"; }

case "${1:-}" in
  create)
    g compute instances create "$NAME" --zone "$ZONE" --machine-type "$MACHINE" \
      --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud \
      --boot-disk-size 30GB --boot-disk-type pd-balanced \
      --labels purpose=sar-lab,ttl=temporary ;;
  ssh)       shift; g compute ssh "$NAME" --zone "$ZONE" -- "$@" ;;
  bootstrap) g compute ssh "$NAME" --zone "$ZONE" -- \
               'curl -fsSL https://raw.githubusercontent.com/servles-com/serverless-ai-agent-run/main/scripts/vm-bootstrap.sh | sudo bash' ;;
  # Forward the API (bound to 127.0.0.1 on the VM) to localhost:8787.
  tunnel)    g compute ssh "$NAME" --zone "$ZONE" -- -N -L 8787:127.0.0.1:8787 ;;
  delete)    g compute instances delete "$NAME" --zone "$ZONE" --quiet ;;
  *) echo "usage: $0 create|ssh|bootstrap|tunnel|delete"; exit 1 ;;
esac
