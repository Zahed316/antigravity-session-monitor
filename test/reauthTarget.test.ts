import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveReauthTarget } from '../src/accounts/reauthTarget.ts';

const ACCOUNTS = [{ email: 'a@example.com' }, { email: 'b@example.com' }];

test('resolveReauthTarget normalizes a known Account email', () => {
  assert.deepEqual(resolveReauthTarget('  B@Example.COM  ', ACCOUNTS), { email: 'b@example.com' });
});

test('resolveReauthTarget rejects an email that is not a saved Account', () => {
  assert.deepEqual(resolveReauthTarget('c@example.com', ACCOUNTS), { error: 'unknown_account' });
});

test('resolveReauthTarget rejects malformed and non-string input before any sign-out', () => {
  for (const bad of ['', '   ', 'not-an-email', '..@..', 42, null, undefined, { email: 'a@example.com' }]) {
    assert.deepEqual(resolveReauthTarget(bad, ACCOUNTS), { error: 'invalid_email' }, `input: ${String(bad)}`);
  }
});

test('resolveReauthTarget does not match a substring or a trailing-char lookalike', () => {
  assert.deepEqual(resolveReauthTarget('xa@example.com', ACCOUNTS), { error: 'unknown_account' });
  assert.deepEqual(resolveReauthTarget('a@example.com.evil', ACCOUNTS), { error: 'unknown_account' });
});