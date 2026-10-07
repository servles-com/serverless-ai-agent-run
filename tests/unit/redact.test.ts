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

// G11 live deltas: a secret split across chunks must never come out in clear.
test('StreamRedactor: a secret split across chunks is masked; released text is a stable prefix', async () => {
  const { setSecrets, StreamRedactor, redact } = await import('../../src/redact.ts');
  const secret = 'redaction-marker-live-ABCDEF0123456789';
  setSecrets([secret, 'short-one']);
  const full = `token is ${secret} and again ${secret}; done`;
  for (const size of [1, 3, 7, 11, 40]) {
    const r = new StreamRedactor();
    let out = '';
    for (let i = 0; i < full.length; i += size) out += r.push(full.slice(i, i + size));
    for (let k = 5; k <= secret.length; k++) assert.ok(!out.includes(secret.slice(0, k)), `leaked a ${k}-char prefix at chunk ${size}`);
    assert.ok(!out.includes(secret), `chunk ${size}`);
    assert.ok(redact(full).startsWith(out), `released text is a prefix of the redacted whole (chunk ${size}): ${out}`);
    assert.ok(out.length >= redact(full).length - secret.length, 'holds back at most one secret length');
  }
  setSecrets([]);
});

test('StreamRedactor: no secrets -> passes through; redactTail drops a cut leading fragment', async () => {
  const { setSecrets, StreamRedactor, redactTail } = await import('../../src/redact.ts');
  setSecrets([]);
  const r = new StreamRedactor();
  assert.equal(r.push('hel') + r.push('lo'), 'hello');
  const secret = 'github-token-test-0123456789abcdefXYZ';
  setSecrets([secret]);
  // The tail starts in the middle of the secret: its remainder cannot be recognised.
  const tail = secret.slice(5) + '\nnext line ' + secret + '\n';
  assert.equal(redactTail(tail, true), 'next line ***\n');
  assert.equal(redactTail('abc' + secret.slice(3), true), '', 'no newline: drop maxSecretLength chars');
  assert.equal(redactTail('x ' + secret, false), 'x ***', 'not truncated: plain redaction');
  setSecrets([]);
});
