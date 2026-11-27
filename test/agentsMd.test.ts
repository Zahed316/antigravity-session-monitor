import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// npm test always runs from the repo root; import.meta is banned by the CJS tsconfig.
const md = readFileSync(path.resolve('AGENTS.md'), 'utf8');

describe('AGENTS.md', () => {
  it('keeps every rule that still binds, each naming its enforcement command', () => {
    const rules: Array<[string, RegExp]> = [
      ['zero runtime dependencies', /Zero runtime dependencies/],
      ['vscode import only in extension.ts', /'vscode'[\s\S]{0,120}src\/extension\.ts/],
      ['read-only telemetry', /read-only/],
      ['erasableSyntaxOnly', /npm run check/],
      ['import extensions', /npm test/],
      ['build on wiring change', /npm run build/],
    ];
    for (const [name, re] of rules) {
      assert.match(md, re, `rule missing: ${name}`);
    }
  });

  it('does not claim codegraph-first exploration without naming the check that keeps files findable', () => {
    if (!/codegraph/i.test(md)) return; // rule removed entirely is fine
    assert.match(md, /codegraph_explore|codegraph explore/, 'a codegraph rule must name the tool');
  });
});
