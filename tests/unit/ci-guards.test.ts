import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate, countTests, parseProbeNames, isSensitivePath, changedLines,
  testCountViolation, probeViolation, focusedTestViolations,
  fixHasTestViolation, securityReviewViolation, sizeViolation,
  SENSITIVE_SUFFIXES, NO_TEST_LABEL, SECURITY_LABEL,
  type FileChange, parseDiff } from '../../scripts/ci/guards.ts';

const change = (path: string, added: string[] = ['x'], removed: string[] = []): FileChange => ({ path, added, removed });

// --- test count ---
test('rule: test count drop is a violation', () =>
  assert.equal(testCountViolation(20, 19)?.rule, 'test-count-dropped'));
test('rule: equal or higher test count is fine', () => {
  assert.equal(testCountViolation(20, 20), null);
  assert.equal(testCountViolation(20, 25), null);
});

// --- isolation probes ---
test('rule: removing an isolation probe is a violation', () =>
  assert.equal(probeViolation(['no_metadata', 'internet_works'], ['no_metadata'])?.rule, 'isolation-probe-removed'));
test('rule: keeping all isolation probes is fine', () =>
  assert.equal(probeViolation(['no_metadata'], ['no_metadata', 'caps_dropped']), null));

// --- focused tests ---
test('rule: added .only is a violation', () =>
  assert.deepEqual(focusedTestViolations([change('tests/unit/x.test.ts', ["test.only('a', () => {})"])]).map(v => v.rule), ['focused-test-added']));
test('rule: added .skip is a violation', () =>
  assert.equal(focusedTestViolations([change('tests/unit/x.test.ts', ["it.skip('a', () => {})"])]).length, 1));
test('rule: description mentioning skip is not a test declaration', () =>
  assert.equal(focusedTestViolations([change('tests/unit/x.test.ts', ["test('rule: added skip is a violation', () => {})"])]).length, 0));
test('rule: .only in a non-test file is ignored', () =>
  assert.equal(focusedTestViolations([change('src/x.ts', ['foo.only(1)'])]).length, 0));
test('rule: plain test line is fine', () =>
  assert.equal(focusedTestViolations([change('tests/unit/x.test.ts', ["test('a', () => {})"])]).length, 0));
test('rule: a string literal mentioning test.only mid-line is not flagged', () =>
  assert.equal(focusedTestViolations([change('tests/unit/x.test.ts', ['assert.equal(parse("test.only(\'a\')"), 1)'])]).length, 0));

// --- fix = test ---
test('rule: src change without a test is a violation', () =>
  assert.equal(fixHasTestViolation([change('src/failures.ts')], [])?.rule, 'fix-without-test'));
test('rule: src change with a test file is fine', () =>
  assert.equal(fixHasTestViolation([change('src/failures.ts'), change('tests/unit/failures.test.ts')], []), null));
test(`rule: src change with '${NO_TEST_LABEL}' label is fine`, () =>
  assert.equal(fixHasTestViolation([change('src/failures.ts')], [NO_TEST_LABEL]), null));
test('rule: docs-only change is fine', () =>
  assert.equal(fixHasTestViolation([change('docs/x.md')], []), null));

// --- sensitive files ---
test('rule: every sensitive file requires security-reviewed', () => {
  const v = securityReviewViolation(SENSITIVE_SUFFIXES.map(p => change(p)), []);
  assert.equal(v?.rule, 'sensitive-file-changed');
  assert.match(v?.message ?? '', /rooms\.ts/);
  assert.match(v?.message ?? '', /isolation\.test\.ts/);
});
test(`rule: '${SECURITY_LABEL}' label clears sensitive files`, () =>
  assert.equal(securityReviewViolation([change('room-image/Dockerfile')], [SECURITY_LABEL]), null));
test('rule: non-sensitive files need no label', () =>
  assert.equal(securityReviewViolation([change('src/server.ts')], []), null));
test('rule: isSensitivePath matches by suffix, not by substring alone', () => {
  assert.equal(isSensitivePath('src/rooms.ts'), true);
  assert.equal(isSensitivePath('deep/nested/room-image/Dockerfile'), true);
  assert.equal(isSensitivePath('src/dining-rooms.ts'), false);
});

// --- PR size ---
test('rule: >600 changed lines is a violation', () =>
  assert.equal(sizeViolation([change('src/x.ts', Array(400).fill('+'), Array(300).fill('-'))])?.rule, 'pr-too-large'));
test('rule: exactly 600 changed lines is fine', () =>
  assert.equal(sizeViolation([change('src/x.ts', Array(300).fill('+'), Array(300).fill('-'))]), null));
test('rule: changedLines counts added and removed', () =>
  assert.equal(changedLines([change('a', ['1', '2'], ['3']), change('b', ['4'])]), 4));

// --- helpers ---
test('countTests counts test/it declarations and ignores describe', () => {
  const src = [
    "test('a', () => {});",
    "it('b', () => {});",
    "describe('c', () => {",
    "  test('d', () => {});",
    '});',
  ].join('\n');
  assert.equal(countTests([{ path: 'tests/unit/x.test.ts', text: src }]), 3);
});
test('countTests ignores non-test files', () =>
  assert.equal(countTests([{ path: 'src/x.ts', text: 'test(1)' }]), 0));
test('parseProbeNames extracts unique check names', () => {
  const src = "check no_metadata 'curl ...'\ncheck internet_works 'curl ...'\ncheck no_metadata 'dup'";
  assert.deepEqual(parseProbeNames(src), ['no_metadata', 'internet_works']);
});

// --- aggregate ---
test('evaluate returns no violations for a clean PR', () =>
  assert.deepEqual(evaluate({
    changes: [change('src/failures.ts'), change('tests/unit/failures.test.ts', ["test('new', () => {})"])],
    labels: [], testCountBase: 20, testCountHead: 21,
    probesBase: ['no_metadata'], probesHead: ['no_metadata'],
  }), []));

test('evaluate collects multiple independent violations', () => {
  const v = evaluate({
    changes: [change('src/failures.ts'), change('tests/e2e/isolation.test.ts', ["check x 'true'"])],
    labels: [], testCountBase: 20, testCountHead: 18,
    probesBase: ['no_metadata', 'internet_works'], probesHead: ['no_metadata'],
  });
  const rules = v.map(x => x.rule);
  assert.deepEqual(rules, ['test-count-dropped', 'isolation-probe-removed', 'sensitive-file-changed']);
});

test('evaluate reports fix-without-test when src changes alone', () => {
  const v = evaluate({
    changes: [change('src/failures.ts')], labels: [],
    testCountBase: 20, testCountHead: 20, probesBase: [], probesHead: [],
  });
  assert.deepEqual(v.map(x => x.rule), ['fix-without-test']);
});

test('parseDiff keeps a deleted file under its old path so the sensitive-file rule still fires', () => {
  const diff = [
    'diff --git a/src/rooms.ts b/src/rooms.ts', 'deleted file mode 100644',
    '--- a/src/rooms.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-line one', '-line two',
    'diff --git a/docs/x.md b/docs/x.md', '--- a/docs/x.md', '+++ b/docs/x.md', '@@ -1 +1 @@', '-old', '+new',
  ].join('\n');
  const changes = parseDiff(diff);
  assert.deepEqual(changes.map(c => c.path), ['src/rooms.ts', 'docs/x.md']);
  assert.equal(changes[0].removed.length, 2);
  assert.ok(securityReviewViolation(changes, []));
});

test('rule: the guard and the workflows are sensitive themselves', () => {
  assert.equal(isSensitivePath('scripts/ci/guards.ts'), true);
  assert.equal(isSensitivePath('scripts/ci/run.ts'), true);
  assert.equal(isSensitivePath('.github/workflows/ci.yml'), true);
  assert.equal(isSensitivePath('scripts/dogfood-status.sh'), false);
});

test('rule: package-lock.json does not count towards PR size', () => {
  const lock = { path: 'package-lock.json', added: Array(5000).fill('x'), removed: [] };
  const code = { path: 'src/a.ts', added: Array(10).fill('x'), removed: [] };
  assert.equal(changedLines([lock, code]), 10);
  assert.equal(sizeViolation([lock, code]), null);
});
