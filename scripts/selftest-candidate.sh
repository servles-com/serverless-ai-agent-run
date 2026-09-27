#!/usr/bin/env bash
# L2 guard (plan task C3): run the selftest against a throwaway *candidate* instance
# of the checked-out code, next to the production service, which is not touched.
#   bash scripts/selftest-candidate.sh      # from a checkout, on the machine, as the CI user
# Candidate: own port, own data dir, own room image tag, own instance label (so it
# never reaps or counts production rooms), dummy secrets only. Everything is removed
# on exit; the selftest log and server log are copied to $SAR_CI_REPORT_DIR.
set -euo pipefail
cd "$(dirname "$0")/.."
SHA=$(git rev-parse HEAD); SHORT=${SHA:0:12}
PORT=${SAR_CI_PORT:-8788}
DATA=${SAR_CI_DATA_ROOT:-/var/lib/sar-ci}/$SHORT
IMAGE=sar-room-opencode:pr-$SHORT
INSTANCE=ci-$SHORT
REPORT=${SAR_CI_REPORT_DIR:-$PWD/ci-report}
TOKEN=$(openssl rand -hex 24)
SERVER_PID=

# shellcheck disable=SC2317,SC2329  # invoked by the EXIT trap
cleanup() {
  set +e
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null && wait "$SERVER_PID" 2>/dev/null
  docker ps -aq --filter label=sar.room=1 --filter "label=sar.instance=$INSTANCE" | xargs -r docker rm -f >/dev/null
  mkdir -p "$REPORT" && cp "$DATA/server.log" "$REPORT/" 2>/dev/null
  docker rmi -f "$IMAGE" >/dev/null 2>&1
  rm -rf "$DATA"
}
trap cleanup EXIT

rm -rf "$DATA" && mkdir -p "$DATA" "$REPORT"
# A dummy secret so the redaction suite has something to redact. Real secrets never reach CI.
echo "CI_DUMMY_SECRET=$(openssl rand -hex 16)" > "$DATA/secrets.env"

echo "=== build room image $IMAGE"
docker build -q -t "$IMAGE" room-image

echo "=== start candidate on 127.0.0.1:$PORT (instance $INSTANCE)"
SAR_API_TOKEN=$TOKEN SAR_HOST=127.0.0.1 SAR_PORT=$PORT SAR_DATA_DIR=$DATA \
  SAR_ROOM_RUNTIME=${SAR_CI_RUNTIME:-runsc} SAR_ROOM_NETWORK=sar-rooms SAR_ROOM_IMAGE=$IMAGE \
  SAR_INSTANCE=$INSTANCE SAR_SECRETS_FILE=$DATA/secrets.env SAR_MAX_ROOMS=2 \
  node src/server.ts > "$DATA/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || { cat "$DATA/server.log"; exit 1; }
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/healthz"; echo

echo "=== selftest against the candidate"
SAR_URL=http://127.0.0.1:$PORT SAR_API_TOKEN=$TOKEN SAR_INSTANCE=$INSTANCE SAR_SECRETS_FILE=$DATA/secrets.env \
  bash scripts/selftest.sh 2>&1 | tee "$REPORT/selftest.log"
exit "${PIPESTATUS[0]}"
