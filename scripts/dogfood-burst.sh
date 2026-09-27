#!/usr/bin/env bash
# Temporarily run dogfood more often, then revert automatically. Run as root on the VM:
#   bash /opt/sar/scripts/dogfood-burst.sh 5min 4h 2     # every 5 min, for 4 h, 2 runs per tick
#   bash /opt/sar/scripts/dogfood-burst.sh off           # revert now
set -euo pipefail
T=/etc/systemd/system/sar-dogfood.timer.d/burst.conf
S=/etc/systemd/system/sar-dogfood.service.d/burst.conf
revert() {
  rm -f "$T" "$S"; systemctl daemon-reload; systemctl restart sar-dogfood.timer
  echo "dogfood burst off: back to the default schedule"
}
if [ "${1:-}" = off ]; then revert; exit 0; fi
EVERY=${1:-5min}; FOR=${2:-4h}; SAMPLE=${3:-2}
mkdir -p "$(dirname "$T")" "$(dirname "$S")"
printf '[Timer]\nOnUnitActiveSec=\nOnUnitActiveSec=%s\n' "$EVERY" > "$T"
# Per-run timeout below the tick length keeps ticks from piling up.
printf '[Service]\nEnvironment=SAR_DOGFOOD_SAMPLE=%s\nEnvironment=SAR_DOGFOOD_TIMEOUT_S=240\n' "$SAMPLE" > "$S"
systemctl daemon-reload
systemctl restart sar-dogfood.timer
systemctl start --no-block sar-dogfood.service
systemctl stop sar-dogfood-burst-off.timer 2>/dev/null || true
systemd-run --quiet --unit sar-dogfood-burst-off --on-active="$FOR" /bin/bash "$0" off
echo "dogfood burst on: every $EVERY, $SAMPLE runs/tick, auto-off in $FOR"
