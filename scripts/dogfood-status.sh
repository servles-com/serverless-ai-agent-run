#!/usr/bin/env bash
# Quick view of the dogfood loop on the VM: last runs, categories, disk, timer.
#   sudo -u sar bash /opt/sar/scripts/dogfood-status.sh [hours=4]
H=${1:-4}
D=${SAR_DATA_DIR:-/var/lib/sar}
since=$(date -u -d "-$H hours" +%Y-%m-%dT%H:%M:%S)
echo "== last $H h"
jq -r --arg s "$since" 'select(.ts > $s) | [.ts[11:19], .state, .category, (.seconds|tostring)+"s", (.model|sub("openrouter/";"")), .task, .run_id] | @tsv' "$D/reports/history.jsonl" | tail -25 | column -t
echo; echo "== categories ($H h)"
jq -r --arg s "$since" 'select(.ts > $s) | .category' "$D/reports/history.jsonl" | sort | uniq -c | sort -rn
echo; echo "== universe-timeline track ($H h)"
[ -f "$D/reports/timeline-history.jsonl" ] && jq -r --arg s "$since" 'select(.ts > $s) | [.ts[11:19], .state, .category, .ci, (if .merged then "merged" else "-" end), "#\(.issue)", (.pr // "-")] | @tsv' "$D/reports/timeline-history.jsonl" | tail -15 | column -t
[ -f "$D/reports/timeline-history.jsonl" ] && jq -rs '"total: \(length) runs, \(map(select(.pr)) | length) PRs, \(map(select(.merged)) | length) merged"' "$D/reports/timeline-history.jsonl"
echo; echo "== disk"; du -sh "$D/runs" 2>/dev/null; df -h "$D" | tail -1
echo; echo "== rooms alive"; docker ps --filter label=sar.room=1 --format '{{.Names}} {{.Status}}'
echo; systemctl list-timers sar-dogfood.timer --no-pager | head -2
