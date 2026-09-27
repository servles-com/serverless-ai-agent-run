// SB1: result contract. "Succeeded but delivered nothing" must fail loudly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDeliverable, validateExpect, globToRegExp, type Deliverable, type Expect } from '../../src/failures.ts';

function d(over: Partial<Deliverable> = {}): Deliverable {
  return { agent: 'opencode', text: 'done', artifacts: [], pullRequest: false, parsesAsJson: () => true, ...over };
}
const cat = (e: Expect | undefined, del: Deliverable) => checkDeliverable(e, del, [])?.diagnosis?.category ?? 'OK';
const evidence = (e: Expect | undefined, del: Deliverable) => checkDeliverable(e, del, [])?.diagnosis?.evidence.join('\n') ?? '';

test('no expect: text alone is a deliverable', () => assert.equal(cat(undefined, d()), 'OK'));
test('no expect: artifact alone is a deliverable', () =>
  assert.equal(cat(undefined, d({ text: '', artifacts: [{ path: 'a.txt', size: 3 }] })), 'OK'));
test('no expect: pull request alone is a deliverable', () => assert.equal(cat(undefined, d({ text: ' ', pullRequest: true })), 'OK'));
test('no expect: no text, only empty artifacts -> NO_DELIVERABLE', () => {
  const v = checkDeliverable(undefined, d({ text: '  ', artifacts: [{ path: 'a.txt', size: 0 }] }), []);
  assert.equal(v?.state, 'FAILED');
  assert.equal(v?.diagnosis?.category, 'NO_DELIVERABLE');
});
test('no expect: shell agent is exempt (deterministic tests)', () => assert.equal(cat(undefined, d({ agent: 'shell', text: '' })), 'OK'));

test('promised artifact missing -> EXPECTATION_NOT_MET', () => {
  const v = checkDeliverable({ artifacts: ['report.md'] }, d({ artifacts: [{ path: 'other.md', size: 5 }] }), ['w']);
  assert.equal(v?.state, 'FAILED');
  assert.equal(v?.diagnosis?.category, 'EXPECTATION_NOT_MET');
  assert.match(v!.diagnosis!.evidence.join(), /artifact missing: report\.md/);
  assert.deepEqual(v?.warnings, ['w'], 'classifier warnings are kept');
});
test('promised artifact present but empty -> EXPECTATION_NOT_MET', () =>
  assert.match(evidence({ artifacts: ['a.txt'] }, d({ artifacts: [{ path: 'a.txt', size: 0 }] })), /artifact empty: a\.txt/));
test('glob patterns', () => {
  assert.equal(cat({ artifacts: ['*.py'] }, d({ artifacts: [{ path: 'fib.py', size: 9 }] })), 'OK');
  assert.equal(cat({ artifacts: ['*.py'] }, d({ artifacts: [{ path: 'src/fib.py', size: 9 }] })), 'EXPECTATION_NOT_MET');
  assert.equal(cat({ artifacts: ['**/*.py'] }, d({ artifacts: [{ path: 'src/fib.py', size: 9 }] })), 'OK');
  assert.equal(cat({ artifacts: ['**/*.py'] }, d({ artifacts: [{ path: 'fib.py', size: 9 }] })), 'OK');
  assert.ok(globToRegExp('a.b?').test('a.bc'));
  assert.ok(!globToRegExp('a.b').test('axb'), 'dot is literal');
});
test('text: true requires a final answer', () => {
  assert.equal(cat({ text: true }, d({ text: '' })), 'EXPECTATION_NOT_MET');
  assert.equal(cat({ text: true }, d()), 'OK');
});
test('text: regex must match, case-insensitive', () => {
  assert.equal(cat({ text: 'ALL TESTS PASS' }, d({ text: 'result: all tests pass' })), 'OK');
  assert.match(evidence({ text: '^ok$' }, d({ text: 'failed' })), /does not match/);
});
test('json: missing and invalid', () => {
  assert.match(evidence({ json: ['out.json'] }, d()), /json missing: out\.json/);
  assert.match(evidence({ json: ['out.json'] }, d({ artifacts: [{ path: 'out.json', size: 2 }], parsesAsJson: () => false })), /json invalid/);
  assert.equal(cat({ json: ['out.json'] }, d({ artifacts: [{ path: 'out.json', size: 2 }] })), 'OK');
});
test('non_empty and github_pr', () => {
  assert.equal(cat({ non_empty: true }, d({ text: '' })), 'EXPECTATION_NOT_MET');
  assert.equal(cat({ github_pr: true }, d()), 'EXPECTATION_NOT_MET');
  assert.equal(cat({ github_pr: true }, d({ pullRequest: true })), 'OK');
});
test('all unmet items are listed, not just the first', () => {
  const ev = evidence({ text: true, artifacts: ['a', 'b'] }, d({ text: '' }));
  for (const s of ['text:', 'artifact missing: a', 'artifact missing: b']) assert.ok(ev.includes(s), ev);
});

test('validateExpect rejects malformed contracts up front', () => {
  assert.equal(validateExpect(undefined, false), undefined);
  assert.equal(validateExpect({ artifacts: ['x.md'], text: true, json: ['a.json'], non_empty: true }, false), undefined);
  assert.match(validateExpect([], false)!, /object/);
  assert.match(validateExpect({ artefacts: ['x'] }, false)!, /unknown expect field/);
  assert.match(validateExpect({ text: 3 }, false)!, /text/);
  assert.match(validateExpect({ text: '(' }, false)!, /regex/);
  assert.match(validateExpect({ artifacts: '/etc/passwd' }, false)!, /relative paths/);
  assert.match(validateExpect({ json: ['../x'] }, false)!, /relative paths/);
  assert.match(validateExpect({ non_empty: 'yes' }, false)!, /boolean/);
  assert.match(validateExpect({ github_pr: true }, false)!, /pull_request/);
  assert.equal(validateExpect({ github_pr: true }, true), undefined);
});
