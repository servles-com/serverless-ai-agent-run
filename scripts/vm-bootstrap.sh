#!/usr/bin/env bash
# One-shot setup of a fresh Ubuntu 24.04 / Debian 12 lab VM. Idempotent; run as root:
#   curl -fsSL https://raw.githubusercontent.com/servles-com/serverless-ai-agent-run/main/scripts/vm-bootstrap.sh | sudo bash
# or, from a checkout:  sudo bash scripts/vm-bootstrap.sh
set -euo pipefail
REPO=${SAR_REPO:-https://github.com/servles-com/serverless-ai-agent-run.git}
BRANCH=${SAR_BRANCH:-main}
export DEBIAN_FRONTEND=noninteractive

log() { echo -e "\n=== $*"; }

log "base packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git jq iptables gh >/dev/null

# Small lab hosts (1 GB RAM) need swap to build the image and run opencode.
if [ "$(swapon --show | wc -l)" -eq 0 ] && [ "$(free -m | awk '/Mem:/{print $2}')" -lt 3000 ]; then
  log "adding 2G swap"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if ! command -v docker >/dev/null; then
  log "docker"
  curl -fsSL https://get.docker.com | sh >/dev/null
fi

if ! command -v runsc >/dev/null; then
  log "gVisor (runsc)"
  curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
    > /etc/apt/sources.list.d/gvisor.list
  apt-get update -qq && apt-get install -y -qq runsc >/dev/null
  runsc install
  systemctl restart docker
fi

if ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 24 ? 0 : 1)' 2>/dev/null; then
  log "node 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

log "service user + code"
id sar >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin sar
usermod -aG docker sar
if [ -n "${SAR_LOCAL_SRC:-}" ]; then            # code shipped by scripts/gcp-lab-vm.sh (private repo)
  mkdir -p /opt/sar && cp -a "$SAR_LOCAL_SRC"/. /opt/sar/
elif [ -d /opt/sar/.git ]; then git -C /opt/sar fetch -q && git -C /opt/sar checkout -q "$BRANCH" && git -C /opt/sar reset -q --hard "origin/$BRANCH"
else git clone -q -b "$BRANCH" "$REPO" /opt/sar; fi
chown -R sar:sar /opt/sar
mkdir -p /var/lib/sar /etc/sar && chown sar:sar /var/lib/sar

if [ ! -f /etc/sar/sar.env ]; then
  sed "s/^SAR_API_TOKEN=.*/SAR_API_TOKEN=$(openssl rand -hex 24)/" /opt/sar/.env.example > /etc/sar/sar.env
fi
[ -f /etc/sar/secrets.env ] || cp /opt/sar/deploy/secrets.env.example /etc/sar/secrets.env
chown root:sar /etc/sar/*.env && chmod 640 /etc/sar/*.env

log "room image"
docker build -q -t sar-room-opencode:latest /opt/sar/room-image

log "systemd units"
cp /opt/sar/deploy/*.service /opt/sar/deploy/*.timer /etc/systemd/system/
chmod +x /opt/sar/scripts/*.sh
systemctl daemon-reload
systemctl enable --now sar-netpolicy.service sar.service sar-dogfood.timer
systemctl restart sar.service                  # pick up new code on re-runs

sleep 2
log "health"
curl -fsS http://127.0.0.1:8787/healthz | jq . || { journalctl -u sar -n 50 --no-pager; exit 1; }
cat <<MSG

Done. Next:
  1. put OPENROUTER_API_KEY (and optionally GITHUB_TOKEN) into /etc/sar/secrets.env, then: systemctl restart sar
  2. run the self test:  sudo -u sar bash /opt/sar/scripts/selftest.sh
  API token: grep SAR_API_TOKEN /etc/sar/sar.env
MSG
