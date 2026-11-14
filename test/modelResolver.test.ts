import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModelCatalogIndex,
  resolveModelName,
  inferModelPool,
} from '../src/core/modelResolver.ts';
import type { ModelCatalogEntry } from '../src/types.ts';

test('resolveModelName: live catalog matches placeholder enum, modelId, and substring', () => {
  const catalogEntries: ModelCatalogEntry[] = [
    {
      label: 'Gemini 4 Argon (Custom)',
      rawId: 'MODEL_PLACEHOLDER_M999',
      modelId: 'gemini-4-argon-custom',
      poolKey: 'argon',
    },
    {
      label: 'Claude Opus 4.6 (Thinking)',
      rawId: 'MODEL_PLACEHOLDER_M525',
      modelId: 'claude-opus-4-6-thinking',
      poolKey: 'nonGoogle',
    },
  ];
  const index = buildModelCatalogIndex(catalogEntries);

  assert.equal(resolveModelName('MODEL_PLACEHOLDER_M999', index), 'Gemini 4 Argon (Custom)');
  assert.equal(resolveModelName('gemini-4-argon-custom', index), 'Gemini 4 Argon (Custom)');
  assert.equal(resolveModelName('claude-opus-4-6-thinking', index), 'Claude Opus 4.6 (Thinking)');
});

test('resolveModelName: static fallback resolves Argon, Opus, Sonnet, Hydrogen, and Flash placeholders', () => {
  assert.equal(resolveModelName('MODEL_PLACEHOLDER_M419'), 'Gemini 4 Argon (Low)');
  assert.equal(resolveModelName('MODEL_PLACEHOLDER_M417'), 'Gemini 4 Argon (High)');
  assert.equal(resolveModelName('MODEL_PLACEHOLDER_M400'), 'Claude Opus 5.5 (Low)');
  assert.equal(resolveModelName('MODEL_PLACEHOLDER_M403'), 'Claude Sonnet 5.5 (Low)');
  assert.equal(resolveModelName('MODEL_PLACEHOLDER_M525'), 'Gemini 4 Hydrogen (High)');
  assert.equal(resolveModelName('MODEL_PLACEHOLDER_M318'), 'Gemini 3.8 Flash (High)');
});

test('resolveModelName: SQLite slugs humanize cleanly and unknown inputs do not crash', () => {
  assert.match(resolveModelName('gemini-4-argon-trial'), /Argon/i);
  assert.match(resolveModelName('claude-opus-4-6-thinking'), /Claude Opus 4\.6/i);
  assert.match(resolveModelName('gemini-3.8-flash-tiered'), /Gemini 3\.8 Flash/i);
  assert.match(resolveModelName('gemini-4-hydrogen'), /Hydrogen/i);
  assert.equal(resolveModelName('MODEL_PLACEHOLDER_M8888'), 'Model M8888');
  assert.equal(resolveModelName(null), 'Unknown');
  assert.equal(resolveModelName(''), 'Unknown');
});

test('inferModelPool: classifies argon, nonGoogle, and gemini accurately', () => {
  assert.equal(inferModelPool('Gemini 4 Argon (Low)'), 'argon');
  assert.equal(inferModelPool('gemini-4-argon-trial'), 'argon');
  assert.equal(inferModelPool('Claude Opus 4.6 (Thinking)'), 'nonGoogle');
  assert.equal(inferModelPool('Claude Sonnet 4.6'), 'nonGoogle');
  assert.equal(inferModelPool('GPT-OSS 120B (Medium)'), 'nonGoogle');
  assert.equal(inferModelPool('Gemini 3.8 Flash'), 'gemini');
  assert.equal(inferModelPool('Gemini 4 Hydrogen'), 'gemini');
});
