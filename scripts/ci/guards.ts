// L1 guard rules for PRs (plan task C2). Pure functions: facts in, violations out.
// scripts/ci/run.ts collects the facts from git/GitHub; tests/unit/ci-guards.test.ts
// pins each rule. No runtime dependencies, erasable TypeScript only.

export type FileChange = {
  path: string;
  added: string[];
  removed: string[];
};

export type GuardInput = {
  changes: FileChange[];
  labels: string[];
  testCountBase: number;
  testCountHead: number;
  probesBase: string[];
  probesHead: string[];
  maxChangedLines?: number;
};

export type Violation = { rule: string; message: string };

export const NO_TEST_LABEL = 'no-test-needed';
export const SECURITY_LABEL = 'security-reviewed';
export const MAX_CHANGED_LINES = 600;

// Path suffixes that require the security-reviewed label. Suffix match keeps this
// stable across renames of parent directories.
export const SENSITIVE_SUFFIXES = [
  'src/rooms.ts',
  'scripts/room-network-policy.sh',
  'room-image/Dockerfile',
  'scripts/vm-bootstrap.sh',
  'tests/e2e/isolation.test.ts',
];

export function isTestPath(path: string): boolean {
  return path.startsWith('tests/') && path.endsWith('.test.ts');
}

export function isSrcPath(path: string): boolean {
  return path.startsWith('src/');
}

// Directories whose every file is sensitive: the guard itself and the workflows
// that run it. Without this a PR could switch the guard off in the same change.
export const SENSITIVE_PREFIXES = [
  'scripts/ci/',
  '.github/workflows/',
];

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_SUFFIXES.some(s => path === s || path.endsWith('/' + s))
    || SENSITIVE_PREFIXES.some(p => path.startsWith(p));
}

export function hasLabel(labels: string[], name: string): boolean {
  return labels.some(l => l.trim().toLowerCase() === name);
}

export function changedLines(changes: FileChange[]): number {
  return changes.reduce((n, c) => n + c.added.length + c.removed.length, 0);
}

// A test is a top-level `test(` / `it(` declaration; `.only`/`.skip` still count,
// since removing it must not be masked by weakening it.
export function countTests(sources: { path: string; text: string }[]): number {
  let n = 0;
  for (const s of sources) {
    if (!isTestPath(s.path)) continue;
    n += s.text.match(/^[ \t]*(?:test|it)(?:\.(?:only|skip))?[ \t]*\(/gm)?.length ?? 0;
  }
  return n;
}

// Isolation probes are `check <name> '<cmd>'` lines inside isolation.test.ts.
export function parseProbeNames(source: string): string[] {
  const names = [...source.matchAll(/^[ \t]*check[ \t]+([A-Za-z0-9_]+)/gm)].map(m => m[1]);
  return [...new Set(names)];
}

export function testCountViolation(base: number, head: number): Violation | null {
  if (head >= base) return null;
  return { rule: 'test-count-dropped', message: `test count dropped: ${base} on base, ${head} on head (removed ${base - head})` };
}

export function probeViolation(base: string[], head: string[]): Violation | null {
  const removed = base.filter(p => !head.includes(p));
  if (removed.length === 0) return null;
  return { rule: 'isolation-probe-removed', message: `isolation probe(s) removed: ${removed.join(', ')}` };
}

// Only lines that declare a focused/skipped test at the start of a line count —
// this keeps string literals and test descriptions that merely mention `test.only(`
// from tripping the rule. The `{ skip: true }` option form is out of scope.
const FOCUS_RE = /^[ \t]*(?:test|it|describe)\.(?:only|skip)[ \t]*\(/;

export function focusedTestViolations(changes: FileChange[]): Violation[] {
  const out: Violation[] = [];
  for (const c of changes) {
    if (!isTestPath(c.path)) continue;
    const hits = c.added.filter(line => FOCUS_RE.test(line));
    if (hits.length > 0) out.push({ rule: 'focused-test-added', message: `${c.path}: added .only/.skip (${hits.length} line(s))` });
  }
  return out;
}

export function fixHasTestViolation(changes: FileChange[], labels: string[]): Violation | null {
  if (hasLabel(labels, NO_TEST_LABEL)) return null;
  const srcChanged = changes.some(c => isSrcPath(c.path));
  const testChanged = changes.some(c => isTestPath(c.path));
  if (srcChanged && !testChanged) {
    return { rule: 'fix-without-test', message: `src/ changed without tests/ — add a test or the '${NO_TEST_LABEL}' label with justification` };
  }
  return null;
}

export function securityReviewViolation(changes: FileChange[], labels: string[]): Violation | null {
  const touched = changes.map(c => c.path).filter(isSensitivePath);
  if (touched.length === 0 || hasLabel(labels, SECURITY_LABEL)) return null;
  return { rule: 'sensitive-file-changed', message: `sensitive file(s) changed without '${SECURITY_LABEL}' label: ${touched.join(', ')}` };
}

export function sizeViolation(changes: FileChange[], max = MAX_CHANGED_LINES): Violation | null {
  const lines = changedLines(changes);
  if (lines <= max) return null;
  return { rule: 'pr-too-large', message: `PR changes ${lines} lines (> ${max}) — split it` };
}

export function evaluate(input: GuardInput): Violation[] {
  const out: Violation[] = [];
  const tc = testCountViolation(input.testCountBase, input.testCountHead);
  if (tc) out.push(tc);
  const pv = probeViolation(input.probesBase, input.probesHead);
  if (pv) out.push(pv);
  out.push(...focusedTestViolations(input.changes));
  const ft = fixHasTestViolation(input.changes, input.labels);
  if (ft) out.push(ft);
  const sr = securityReviewViolation(input.changes, input.labels);
  if (sr) out.push(sr);
  const sz = sizeViolation(input.changes, input.maxChangedLines);
  if (sz) out.push(sz);
  return out;
}

// Unified diff → per-file added/removed lines. A deleted file has `+++ /dev/null`;
// it is kept under its old path so deleting a sensitive file still trips the guard.
export function parseDiff(diff: string): FileChange[] {
  const changes: FileChange[] = [];
  let current: FileChange | null = null;
  let oldPath: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ')) {
      const p = line.slice(4).trim();
      oldPath = p === '/dev/null' ? null : p.replace(/^a\//, '');
    } else if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      const path = p === '/dev/null' ? oldPath : p.replace(/^b\//, '');
      current = path ? { path, added: [], removed: [] } : null;
      if (current) changes.push(current);
    } else if (line.startsWith('diff --git') || line.startsWith('@@') || line.startsWith('\\')) {
      continue;
    } else if (current && line.startsWith('+')) {
      current.added.push(line.slice(1));
    } else if (current && line.startsWith('-')) {
      current.removed.push(line.slice(1));
    }
  }
  return changes;
}
