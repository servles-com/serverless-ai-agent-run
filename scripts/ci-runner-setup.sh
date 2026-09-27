#!/usr/bin/env bash
# One-time setup of the GitHub Actions self-hosted runner on the machine (plan task C3).
# Run as root; the registration token is short-lived and passed via env, never stored:
#   token=$(gh api -X POST repos/<owner>/<repo>/actions/runners/registration-token --jq .token)
#   echo "$token" | SAR_SSH=... bash scripts/machine.sh ssh 'sudo RUNNER_TOKEN=$(cat) bash /opt/sar/scripts/ci-runner-setup.sh'
# The runner runs as user `ci` (docker group: it builds images and starts rooms), picks up
# only jobs labelled `sar-machine`, and never touches the production service or its data.
set -euo pipefail
REPO_URL=${SAR_REPO_URL:-https://github.com/servles-com/serverless-ai-agent-run}
DIR=/home/ci/actions-runner
: "${RUNNER_TOKEN:?RUNNER_TOKEN (registration token) is required}"

id ci >/dev/null 2>&1 || useradd --create-home --shell /bin/bash ci
usermod -aG docker ci
mkdir -p /var/lib/sar-ci && chown ci:ci /var/lib/sar-ci

if [ ! -x "$DIR/run.sh" ]; then
  ver=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name | sed 's/^v//')
  sudo -u ci mkdir -p "$DIR"
  curl -fsSL "https://github.com/actions/runner/releases/download/v$ver/actions-runner-linux-x64-$ver.tar.gz" \
    | sudo -u ci tar -xz -C "$DIR"
  "$DIR/bin/installdependencies.sh" >/dev/null
fi

if [ ! -f "$DIR/.runner" ]; then
  sudo -u ci "$DIR/config.sh" --unattended --url "$REPO_URL" --token "$RUNNER_TOKEN" \
    --name "$(hostname)" --labels sar-machine --work _work --replace
fi
cd "$DIR"
if ! ./svc.sh status 2>/dev/null | grep -q 'active (running)'; then
  ./svc.sh install ci 2>/dev/null || true      # already installed -> just start
  ./svc.sh start
fi
./svc.sh status | head -5
