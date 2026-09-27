#!/usr/bin/env bash
# Full self-test against a running server. Exit code != 0 means the runtime is broken.
#   bash scripts/selftest.sh            # unit + failure modes + isolation
#   SAR_LIVE=1 bash scripts/selftest.sh # + one live opencode run on a free model
# Reads SAR_URL / SAR_API_TOKEN, falling back to /etc/sar/sar.env on the VM.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
if [ -z "${SAR_API_TOKEN:-}" ] && [ -r /etc/sar/sar.env ]; then
  set -a; . /etc/sar/sar.env; set +a
fi
export SAR_URL=${SAR_URL:-http://127.0.0.1:${SAR_PORT:-8787}}

status=0
step() { echo; echo "=== $1"; shift; "$@" || status=1; }

step "unit: failure classifier" node --test tests/unit/*.test.ts
step "e2e: failure modes"       node --test --test-concurrency=1 tests/e2e/failure-modes.test.ts
step "e2e: isolation"           node --test --test-concurrency=1 tests/e2e/isolation.test.ts
step "e2e: batches"           node --test --test-concurrency=1 tests/e2e/batches.test.ts
step "e2e: credentials"       node --test --test-concurrency=1 tests/e2e/credentials.test.ts
step "e2e: secret redaction"    node --test --test-concurrency=1 tests/e2e/redaction.test.ts
step "e2e: streaming"           node --test --test-concurrency=1 tests/e2e/stream.test.ts
if [ "${SAR_LIVE:-0}" = "1" ]; then
  step "e2e: live opencode"     node --test tests/e2e/opencode-live.test.ts
fi

echo
[ $status -eq 0 ] && echo "SELFTEST PASSED" || echo "SELFTEST FAILED"
exit $status
