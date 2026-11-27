import test from 'node:test';
import assert from 'node:assert/strict';

import { purgeRemovedAccountCredential } from '../src/accounts/vaultPurge.ts';

test('purgeRemovedAccountCredential purges the normalized email silently on success (C4)', async () => {
  const calls: string[] = [];
  const note = await purgeRemovedAccountCredential(
    // deleteCredential itself normalizes; the helper passes the email through.
    { deleteCredential: async (email: string) => void calls.push(email) },
    'Dev@Example.COM',
  );
  assert.equal(note, '');
  assert.deepEqual(calls, ['Dev@Example.COM']);
});

test('purgeRemovedAccountCredential surfaces failures without throwing (C4)', async () => {
  const note = await purgeRemovedAccountCredential(
    { deleteCredential: async () => {
      throw new Error('secret_storage_failed');
    } },
    'dev@example.com',
  );
  assert.ok(note.includes('vault'), 'the removal confirmation must carry a visible warning');
});
