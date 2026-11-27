import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// npm test always runs from the repo root; import.meta is banned by the CJS tsconfig.
const repo = process.cwd();

describe('sdd-verify', () => {
  it('exits non-zero and names the failing command when a check fails', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sddverify-'));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      scripts: { check: 'node -e "process.exit(1)"', test: 'node -e "process.exit(0)"', build: 'node -e "process.exit(0)"' },
    }));
    let out = '';
    let code = 0;
    try {
      out = execFileSync(path.join(repo, 'scripts/sdd-verify'), { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      out = String((e as { stdout?: string }).stdout ?? '');
      code = (e as { status?: number }).status ?? -1;
    }
    assert.notEqual(code, 0, 'a failing check must fail the script');
    assert.match(out, /check/);
    assert.doesNotMatch(out, /^OK$/m);
  });

  it('prints OK and exits 0 when every command passes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sddverify-'));
    const ok = 'node -e "process.exit(0)"';
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { check: ok, test: ok, build: ok } }));
    const out = execFileSync(path.join(repo, 'scripts/sdd-verify'), { cwd: dir, encoding: 'utf8' });
    assert.match(out, /^OK$/m);
    assert.match(out, /PASS npm test/, 'OK must mean the commands actually ran');
  });
});

describe('sdd-note', () => {
  it('appends one line to the ledger when SDD_LEDGER points at a fresh file (no silent guessing)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sddnote-'));
    const ledger = path.join(dir, '.superpowers/sdd/plan/progress.md');
    const env = { ...process.env, SDD_LEDGER: ledger };
    execFileSync(path.join(repo, 'scripts/sdd-note'), ['Task 3 done'], { cwd: dir, encoding: 'utf8', env });
    assert.match(readFileSync(ledger, 'utf8'), /Task 3 done/);
    execFileSync(path.join(repo, 'scripts/sdd-note'), ['second'], { cwd: dir, encoding: 'utf8', env });
    assert.equal(readFileSync(ledger, 'utf8').trim().split('\n').length, 2, 'appends, never rewrites');
  });

  it('refuses (exit 1) instead of guessing when several ledgers exist and SDD_LEDGER is unset', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sddnote-'));
    for (const p of ['a/progress.md', 'b/progress.md']) {
      const full = path.join(dir, '.superpowers/sdd', p);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, 'x\n');
    }
    let code = 0;
    try {
      execFileSync(path.join(repo, 'scripts/sdd-note'), ['nope'], { cwd: dir, encoding: 'utf8' });
    } catch (e) {
      code = (e as { status?: number }).status ?? -1;
    }
    assert.notEqual(code, 0, 'multiple ledgers without SDD_LEDGER must refuse, not guess');
  });
});
