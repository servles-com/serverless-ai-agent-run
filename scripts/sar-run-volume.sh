#!/usr/bin/env bash
# Per-run disk quota (checklist 1.12, #28). Installed root-owned as /usr/local/sbin/sar-run-volume
# by vm-bootstrap.sh; the service users may run ONLY this via sudo (/etc/sudoers.d/sar-run-volume).
#   sar-run-volume create  <run_dir> <size_mb>   sparse ext4 image, mounted; workspace/ and artifacts/
#                                                 of the run dir are bind mounts into it
#   sar-run-volume release <run_dir>             copy artifacts (and a small workspace) back to plain
#                                                 dirs, unmount, delete the image. Idempotent.
# The caller controls both arguments, so both are validated: the run dir must be a run of the main
# service or of a CI candidate, and must not be a symlink.
set -euo pipefail
cmd=${1:-}; dir=${2:-}
KEEP_WORKSPACE_MB=${SAR_KEEP_WORKSPACE_MB:-64}

die() { echo "sar-run-volume: $*" >&2; exit 2; }
[ -n "$dir" ] || die "usage: $0 create <run_dir> <size_mb> | release <run_dir>"
[ -L "$dir" ] && die "run dir is a symlink"
real=$(realpath -e -- "$dir") || die "no such run dir"
[[ "$real" =~ ^/var/lib/sar(-ci/[0-9a-f]{12})?/runs/run_[0-9a-z_]+$ ]] || die "not a run dir: $real"
img="$real/volume.img"; vol="$real/vol"
owner=$(stat -c %u:%g "$real")

case "$cmd" in
  create)
    size=${3:-}
    if ! [[ "$size" =~ ^[0-9]+$ ]] || [ "$size" -lt 16 ] || [ "$size" -gt 65536 ]; then die "size_mb must be 16..65536"; fi
    mountpoint -q "$vol" && die "already mounted"
    for d in workspace artifacts; do [ -L "$real/$d" ] && die "$d is a symlink"; done
    truncate -s "${size}M" "$img"
    mkfs.ext4 -q -F -m 0 -E lazy_itable_init=1,lazy_journal_init=1,nodiscard "$img"
    mkdir -p "$vol"
    mount -o loop,nosuid,nodev "$img" "$vol"
    mkdir -p "$vol/workspace" "$vol/artifacts" "$real/workspace" "$real/artifacts"
    rmdir "$vol/lost+found" 2>/dev/null || true
    chown "$owner" "$vol" "$vol/workspace" "$vol/artifacts"
    mount --bind "$vol/workspace" "$real/workspace"
    mount --bind "$vol/artifacts" "$real/artifacts"
    ;;
  release)
    if mountpoint -q "$vol"; then
      for d in workspace artifacts; do mountpoint -q "$real/$d" && umount "$real/$d"; done
      # Results live on: artifacts always (bounded by the quota), workspace only if small.
      cp -a "$vol/artifacts/." "$real/artifacts/"
      used=$(du -sm "$vol/workspace" | cut -f1)
      if [ "$used" -le "$KEEP_WORKSPACE_MB" ]; then cp -a "$vol/workspace/." "$real/workspace/"
      else echo "workspace was ${used} MB; not kept (limit ${KEEP_WORKSPACE_MB} MB)" > "$real/workspace/.sar-workspace-not-kept"
        chown "$owner" "$real/workspace/.sar-workspace-not-kept"; fi
      umount "$vol" || umount -l "$vol"
    fi
    rm -f "$img"; rmdir "$vol" 2>/dev/null || true
    ;;
  *) die "unknown command: $cmd" ;;
esac
