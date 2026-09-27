// Per-run disk quota (checklist 1.12, #28): /workspace and /artifacts of a run live on
// their own fixed-size ext4 image, so a room can fill only its own quota, never the host.
// Mounting needs root: the service calls only scripts/sar-run-volume.sh via sudo, which
// validates the run dir (see vm-bootstrap.sh for the sudoers rule). Off when the size is 0.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';

const exec = promisify(execFile);

// limits.disk_mb, validated at request time.
export function validateDiskLimit(v: unknown, enabled: boolean, max: number): string | undefined {
  if (v === undefined) return undefined;
  if (!enabled) return 'limits.disk_mb: disk quotas are not enabled on this server (SAR_DEFAULT_DISK_MB=0)';
  if (!Number.isInteger(v) || (v as number) < 16 || (v as number) > max) return `limits.disk_mb must be an integer 16..${max}`;
  return undefined;
}

export const volumeMounted = (runDir: string) => existsSync(join(runDir, 'vol', 'workspace'));

export async function createVolume(runDir: string, sizeMb: number): Promise<void> {
  await exec('sudo', ['-n', config.volumeHelper, 'create', runDir, String(sizeMb)], { timeout: 60_000 });
}

// Sync on purpose: called from finish(), so artifacts are back in the plain run dir
// before run.completed goes out. Copying is bounded by the quota.
export function releaseVolume(runDir: string): string | undefined {
  if (!existsSync(join(runDir, 'vol')) && !existsSync(join(runDir, 'volume.img'))) return undefined;
  try {
    execFileSync('sudo', ['-n', config.volumeHelper, 'release', runDir], { timeout: 300_000, stdio: ['ignore', 'ignore', 'pipe'] });
    return undefined;
  } catch (e: unknown) {
    const err = e as { stderr?: Buffer; message?: string };
    return String(err.stderr ?? err.message ?? e).trim().slice(0, 500);
  }
}

// "Full" = less than 1% (at least 1 MB) left. Checked right after the room stops.
export function volumeFull(runDir: string): boolean {
  if (!volumeMounted(runDir)) return false;
  try {
    const s = statfsSync(join(runDir, 'vol'));
    const free = s.bavail * s.bsize, total = s.blocks * s.bsize;
    return free < Math.max(1 << 20, total / 100);
  } catch { return false; }
}
