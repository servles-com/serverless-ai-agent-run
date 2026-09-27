// Host-side pull requests: the agent only edits files in /workspace; the host
// turns those edits into a branch + PR. The push token never enters the room.
//
// Safety: the room controls /workspace, including /workspace/.git. Running git
// in there on the host would execute agent-controlled hooks / config
// (core.hooksPath, core.fsmonitor, filters, sshCommand...) = sandbox escape.
// So the host keeps its OWN pristine clone outside the room, copies the agent's
// files into it (never .git, symlinks copied as links, not followed) and commits
// there with hooks disabled and no system/global config.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, readdirSync, rmSync, lstatSync } from 'node:fs';
import { join, relative } from 'node:path';

const exec = promisify(execFile);

export interface PullRequestSpec { base?: string; title?: string; body?: string; branch?: string }
export interface PullRequestResult { url: string; number: number; branch: string; files_changed: number; commit: string }

export class PullRequestError extends Error {
  category: string;
  retryable: boolean;
  constructor(category: string, message: string, retryable: boolean) {
    super(message);
    this.category = category;
    this.retryable = retryable;
  }
}

interface GitHubPull { html_url: string; number: number }

export const LIMITS = { maxFiles: 200, maxBytes: 2 * 1024 * 1024 };

// "https://github.com/owner/repo(.git)" -> "owner/repo"
export function githubSlug(url: string): string | undefined {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

export function repoAllowed(url: string, allowlist: string[]): boolean {
  const slug = githubSlug(url);
  return !!slug && allowlist.map(s => s.toLowerCase()).includes(slug.toLowerCase());
}

export function branchName(runId: string, spec: PullRequestSpec): string {
  const b = spec.branch ?? `agent/${runId}`;
  if (!/^[\w./-]{1,100}$/.test(b) || b.includes('..') || b.startsWith('/') || b.endsWith('/')) {
    throw new PullRequestError('PR_FAILED', `invalid branch name: ${b}`, false);
  }
  return b;
}

// Git with no hooks, no system/global config, no prompts. `cwd` is always the host clone.
function git(cwd: string, args: string[], token?: string) {
  const auth = token ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`] : [];
  return exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...auth, ...args], {
    cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'sar-agent', GIT_AUTHOR_EMAIL: 'sar-agent@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'sar-agent', GIT_COMMITTER_EMAIL: 'sar-agent@users.noreply.github.com' },
  });
}

// Pristine clone made by the host at hydrate time, before the room starts.
export async function hostClone(url: string, ref: string | undefined, dir: string, token?: string) {
  const args = ['clone', '--depth', '50'];
  if (ref) args.push('--branch', ref);
  await git(process.cwd(), [...args, url, dir], token);
}

// Mirror the agent's files (minus .git) into the host clone's worktree.
export function syncWorktree(workspace: string, hostRepo: string): void {
  for (const name of readdirSync(hostRepo)) if (name !== '.git') rmSync(join(hostRepo, name), { recursive: true, force: true });
  for (const name of readdirSync(workspace)) {
    if (name === '.git') continue;
    cpSync(join(workspace, name), join(hostRepo, name), {
      recursive: true, verbatimSymlinks: true, dereference: false,
      filter: src => !relative(workspace, src).split('/').includes('.git') && !isSpecial(src),
    });
  }
}

function isSpecial(p: string): boolean {
  const st = lstatSync(p);
  return !(st.isFile() || st.isDirectory() || st.isSymbolicLink());
}

export async function openPullRequest(opts: {
  runId: string; repoUrl: string; hostRepo: string; workspace: string; spec: PullRequestSpec;
  defaultBase?: string; token: string; title: string; body: string;
}): Promise<PullRequestResult> {
  const slug = githubSlug(opts.repoUrl)!;
  const branch = branchName(opts.runId, opts.spec);
  syncWorktree(opts.workspace, opts.hostRepo);

  await git(opts.hostRepo, ['add', '-A']);
  const { stdout: numstat } = await git(opts.hostRepo, ['diff', '--cached', '--numstat']);
  const files = numstat.split('\n').filter(Boolean);
  if (files.length === 0) throw new PullRequestError('NO_CHANGES', 'Agent finished but changed no files in the repository', true);
  if (files.length > LIMITS.maxFiles) throw new PullRequestError('CHANGE_TOO_LARGE', `${files.length} files changed (max ${LIMITS.maxFiles})`, false);
  const { stdout: patch } = await git(opts.hostRepo, ['diff', '--cached']);
  if (patch.length > LIMITS.maxBytes) throw new PullRequestError('CHANGE_TOO_LARGE', `diff is ${patch.length} bytes (max ${LIMITS.maxBytes})`, false);

  await git(opts.hostRepo, ['checkout', '-B', branch]);
  await git(opts.hostRepo, ['commit', '-m', opts.title, '-m', `Run: ${opts.runId}`]);
  const { stdout: sha } = await git(opts.hostRepo, ['rev-parse', 'HEAD']);
  try {
    await git(opts.hostRepo, ['push', '--force', 'origin', `HEAD:refs/heads/${branch}`], opts.token);
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new PullRequestError('PR_FAILED', `push failed: ${String(err.stderr || err.message).slice(0, 500)}`, true);
  }

  const base = opts.spec.base ?? opts.defaultBase ?? 'main';
  const gh = (path: string, init: RequestInit = {}) => fetch(`https://api.github.com/repos/${slug}${path}`, {
    ...init, headers: { authorization: `Bearer ${opts.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
  });
  // Re-runs for the same branch update the existing PR instead of opening a duplicate.
  const owner = slug.split('/')[0];
  const existing = await (await gh(`/pulls?head=${owner}:${encodeURIComponent(branch)}&state=open`)).json() as GitHubPull[];
  let pr: GitHubPull | undefined = Array.isArray(existing) ? existing[0] : undefined;
  if (!pr) {
    const res = await gh('/pulls', { method: 'POST', body: JSON.stringify({ title: opts.title, body: opts.body, head: branch, base }) });
    const created = await res.json() as GitHubPull;
    if (!res.ok) throw new PullRequestError('PR_FAILED', `create PR: HTTP ${res.status} ${JSON.stringify(created).slice(0, 300)}`, true);
    pr = created;
  }
  return { url: pr.html_url, number: pr.number, branch, files_changed: files.length, commit: sha.trim() };
}
