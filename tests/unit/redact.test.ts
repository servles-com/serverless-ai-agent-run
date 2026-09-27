import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setSecrets, redact, scrub, PLACEHOLDER } from '../../src/redact.ts';

test('replaces a known secret value anywhere in a string', () => {
  setSecrets(['sk-live-abcdef123456']);
  assert.equal(redact('token=sk-live-abcdef123456 end'), `token=${PLACEHOLDER} end`); // gitleaks:allow (fake fixture)
  assert.equal(redact('sk-live-abcdef123456'), PLACEHOLDER);
  assert.equal(redact('nothing secret here'), 'nothing secret here');
});

test('masks every occurrence and multiple distinct secrets', () => {
  setSecrets(['first-secret-value', 'second-secret-value']);
  assert.equal(redact('a first-secret-value b first-secret-value c second-secret-value'),
    `a ${PLACEHOLDER} b ${PLACEHOLDER} c ${PLACEHOLDER}`);
});

test('ignores empty and too-short values so normal text is not shredded', () => {
  setSecrets(['', 'ab', 'ok-long-secret']);
  assert.equal(redact('ab is common, ok-long-secret is not'), `ab is common, ${PLACEHOLDER} is not`);
});

test('masks the longest secret first when one contains another', () => {
  setSecrets(['abc123', 'abc123456789']);
  assert.equal(redact('abc123456789'), PLACEHOLDER);
});

test('scrub deep-redacts strings in objects and arrays but keeps types', () => {
  setSecrets(['sk-deep-secret-9999']);
  const input = {
    line: 'echo sk-deep-secret-9999',
    nested: { list: ['sk-deep-secret-9999', 7, true, null] },
    count: 3,
  };
  const out = scrub(input);
  assert.deepEqual(out, {
    line: `echo ${PLACEHOLDER}`,
    nested: { list: [PLACEHOLDER, 7, true, null] },
    count: 3,
  });
});

test('redaction is idempotent', () => {
  setSecrets(['sk-idempotent-1234']);
  const once = redact('x sk-idempotent-1234 y');
  assert.equal(redact(once), once);
});
