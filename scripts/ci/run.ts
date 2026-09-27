// Runs the L1 PR guards (plan task C2). Collects facts from git + the PR event,
// then applies scripts/ci/guards.ts. Exit 1 (with a readable report) on any
// violation. Labels: 'no-test-needed' skips the fix=test rule, 'security-reviewed'
// skips the sensitive-file rule.
//
//   node scripts/ci/run.ts                 base = $SAR_CI_BASE || origin/$GITHUB_BASE_REF || origin/main
//   SAR_CI_BASE=origin/main SAR_PR_LABELS=no-test-needed node scripts/ci/run.ts
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  evaluate, isTestPath, countTests, parseProbeNames,
  type FileChange, type Violation,
} from './guards.ts';

const git = (args: string[]): string => execFileSync('git', args, { encoding: 'utf8' });
const gitTry = (args: string[]): string | null => {
  try { return git(args); } catch { return null; }
};

const base = process.env.SAR_CI_BASE
  ?? (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/main');

function readLabels(): string[] {
  if (process.env.SAR_PR_LABELS !== undefined) return process.env.SAR_PR_LABELS.split(',').map(s => s.trim()).filter(Boolean);
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && existsSync(eventPath)) {
    try {
      const ev = JSON.parse(readFileSync(eventPath, 'utf8'));
      return (ev.pull_request?.labels ?? []).map((l: { name: string }) => l.name);
    } catch { /* fall through */ }
  }
  return [];
}

function parseDiff(diff: string): FileChange[] {
  const changes: FileChange[] = [];
  let current: FileChange | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim().replace(/^b\//, '');
      current = path === '/dev/null' ? null : { path, added: [], removed: [] };
      if (current) changes.push(current);
    } else if (line.startsWith('--- ') || line.startsWith('diff --git') || line.startsWith('@@') || line.startsWith('\\')) {
      continue;
    } else if (current && line.startsWith('+')) {
      current.added.push(line.slice(1));
    } else if (current && line.startsWith('-')) {
      current.removed.push(line.slice(1));
    }
  }
  return changes;
}

function collectTestSources(rev: string | null, fromDisk: boolean): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  if (fromDisk) {
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (isTestPath(p)) out.push({ path: p, text: readFileSync(p, 'utf8') });
      }
    };
    if (existsSync('tests')) walk('tests');
  } else if (rev) {
    for (const path of gitTry(['ls-tree', '-r', '--name-only', rev, '--', 'tests'])?.split('\n').filter(Boolean) ?? []) {
      if (!isTestPath(path)) continue;
      const text = gitTry(['show', `${rev}:${path}`]);
      if (text !== null) out.push({ path, text });
    }
  }
  return out;
}

function isolationSource(rev: string | null): string {
  const path = 'tests/e2e/isolation.test.ts';
  if (rev) return gitTry(['show', `${rev}:${path}`]) ?? '';
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const mergeBase = git(['merge-base', base, 'HEAD']).trim();
const diff = git(['diff', '--unified=0', `${base}...HEAD`]);
const changes = parseDiff(diff);

const testCountBase = countTests(collectTestSources(mergeBase, false));
const testCountHead = countTests(collectTestSources(null, true));
const probesBase = parseProbeNames(isolationSource(mergeBase));
const probesHead = parseProbeNames(isolationSource(null));
const labels = readLabels();

const violations: Violation[] = evaluate({ changes, labels, testCountBase, testCountHead, probesBase, probesHead });

console.log(`ci guards: base=${base} (${mergeBase.slice(0, 10)}) tests ${testCountBase}->${testCountHead} ` +
  `probes ${probesBase.length}->${probesHead.length} labels=[${labels.join(',')}]`);
if (violations.length === 0) {
  console.log('ci guards: OK');
} else {
  console.error(`ci guards: ${violations.length} violation(s)`);
  for (const v of violations) console.error(`  [${v.rule}] ${v.message}`);
  process.exit(1);
}
