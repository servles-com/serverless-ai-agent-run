// Reading files the room wrote. The room controls /workspace and /artifacts, so any
// entry there may be a symlink pointing at the host (e.g. /etc/sar/secrets.env):
// never follow one. Listing skips symlinks; opening refuses a symlink in the last
// component (O_NOFOLLOW) and then checks where the opened descriptor really points,
// which also covers symlinked parent dirs and swaps between check and open.
import { lstatSync, readdirSync, existsSync, openSync, closeSync, fstatSync, readlinkSync, realpathSync, constants } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export function listFiles(root: string, base = root): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    const st = lstatSync(full);
    if (st.isDirectory()) out.push(...listFiles(full, base));
    else if (st.isFile()) out.push(relative(base, full));
  }
  return out.sort();
}

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

// A read-only fd for a regular file strictly inside root, or undefined.
export function openInside(root: string, rel: string): number | undefined {
  let realRoot: string;
  try { realRoot = realpathSync(root); } catch { return undefined; }
  const target = resolve(realRoot, rel);
  if (!within(realRoot, target) || target === realRoot) return undefined;
  let fd: number;
  try { fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch { return undefined; }
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a regular file');
    // Linux: where the descriptor really points. Elsewhere (dev on macOS): realpath.
    let real: string;
    try { real = readlinkSync(`/proc/self/fd/${fd}`); } catch { real = realpathSync(target); }
    if (!within(realRoot, real)) throw new Error('escapes root');
    return fd;
  } catch {
    closeSync(fd);
    return undefined;
  }
}

// Before writing an input file into a workspace that may hold a cloned (untrusted)
// repo: no existing component of the path may be a symlink, or the write lands on the host.
export function symlinkOnPath(root: string, rel: string): string | undefined {
  let cur = root;
  for (const part of rel.split('/').filter(Boolean)) {
    cur = join(cur, part);
    try { if (lstatSync(cur).isSymbolicLink()) return relative(root, cur); } catch { return undefined; }
  }
  return undefined;
}
