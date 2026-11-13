import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONTEXT_LIMIT } from '../src/types.ts';
import {
  hexToBytes,
  parseGenMetadataBlob,
  parseSubagentRoleFromSummary,
  parseTrajectoryMetaBlob,
} from '../src/data/protobuf.ts';

const encoder = new TextEncoder();

function encodeVarint(val: number | bigint): Uint8Array {
  let v = typeof val === 'bigint' ? val : BigInt(val);
  if (v < 0n) {
    v = BigInt.asUintN(64, v);
  }
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) {
      byte |= 0x80;
    }
    out.push(byte);
  } while (v > 0n);
  return Uint8Array.from(out);
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function fieldVarint(fieldNumber: number, value: number | bigint): Uint8Array {
  const key = encodeVarint((BigInt(fieldNumber) << 3n) | 0n);
  return concatBytes(key, encodeVarint(value));
}

function fieldBytes(fieldNumber: number, payload: Uint8Array): Uint8Array {
  const key = encodeVarint((BigInt(fieldNumber) << 3n) | 2n);
  return concatBytes(key, encodeVarint(payload.length), payload);
}

function fieldString(fieldNumber: number, text: string): Uint8Array {
  return fieldBytes(fieldNumber, encoder.encode(text));
}

function fieldFixed64(fieldNumber: number, fillByte = 0x11): Uint8Array {
  const key = encodeVarint((BigInt(fieldNumber) << 3n) | 1n);
  const data = new Uint8Array(8).fill(fillByte);
  return concatBytes(key, data);
}

function fieldFixed32(fieldNumber: number, fillByte = 0x22): Uint8Array {
  const key = encodeVarint((BigInt(fieldNumber) << 3n) | 5n);
  const data = new Uint8Array(4).fill(fillByte);
  return concatBytes(key, data);
}

function fieldPackedVarints(fieldNumber: number, values: Array<number | bigint>): Uint8Array {
  const body = concatBytes(...values.map((v) => encodeVarint(v)));
  return fieldBytes(fieldNumber, body);
}

interface SyntheticGenOptions {
  model?: string;
  stepIndices?: Array<number | bigint>;
  packedStepIndices?: boolean;
  fresh?: number | bigint;
  output?: number | bigint;
  cacheRead?: number | bigint;
  thinking?: number | bigint;
  response?: number | bigint;
  includeUsage?: boolean;
  startStepIndex?: number | bigint;
  rowContext?: number | bigint;
  rowLimit?: number | bigint;
  includeChatStartMetadata?: boolean;
  includeSiblings?: boolean;
}

function buildGenMetadataBlob(opts: SyntheticGenOptions): Uint8Array {
  const chatModelParts: Uint8Array[] = [];

  if (opts.includeSiblings) {
    chatModelParts.push(fieldVarint(3, 1528));
    chatModelParts.push(fieldFixed64(98, 0xaa));
    chatModelParts.push(fieldFixed32(99, 0xbb));
  }

  if (opts.includeUsage !== false) {
    const usageParts: Uint8Array[] = [];
    if (opts.fresh !== undefined) usageParts.push(fieldVarint(2, opts.fresh));
    if (opts.output !== undefined) usageParts.push(fieldVarint(3, opts.output));
    if (opts.cacheRead !== undefined) usageParts.push(fieldVarint(5, opts.cacheRead));
    if (opts.thinking !== undefined) usageParts.push(fieldVarint(9, opts.thinking));
    if (opts.response !== undefined) usageParts.push(fieldVarint(10, opts.response));
    if (opts.includeSiblings) {
      usageParts.push(fieldString(7, 'req-extra'));
      usageParts.push(fieldFixed32(12, 0x01));
    }
    chatModelParts.push(fieldBytes(4, concatBytes(...usageParts)));
  }

  const hasStartMeta =
    opts.includeChatStartMetadata === true ||
    opts.startStepIndex !== undefined ||
    opts.rowContext !== undefined ||
    opts.rowLimit !== undefined;

  if (hasStartMeta) {
    const startParts: Uint8Array[] = [];
    if (opts.startStepIndex !== undefined) {
      startParts.push(fieldVarint(2, opts.startStepIndex));
    }
    if (opts.rowContext !== undefined || opts.rowLimit !== undefined) {
      const ctxParts: Uint8Array[] = [];
      if (opts.rowContext !== undefined) ctxParts.push(fieldVarint(1, opts.rowContext));
      if (opts.rowLimit !== undefined) ctxParts.push(fieldVarint(4, opts.rowLimit));
      startParts.push(fieldBytes(10, concatBytes(...ctxParts)));
    }
    chatModelParts.push(fieldBytes(9, concatBytes(...startParts)));
  }

  if (opts.model !== undefined) {
    chatModelParts.push(fieldString(19, opts.model));
  }

  const topParts: Uint8Array[] = [];
  if (opts.stepIndices && opts.stepIndices.length > 0) {
    if (opts.packedStepIndices !== false) {
      topParts.push(fieldPackedVarints(2, opts.stepIndices));
    } else {
      for (const s of opts.stepIndices) {
        topParts.push(fieldVarint(2, s));
      }
    }
  }
  if (opts.includeSiblings) {
    topParts.push(fieldString(4, '00000000-0000-4000-8000-000000000001'));
    topParts.push(fieldBytes(8, fieldString(1, 'planner-config')));
    topParts.push(fieldFixed64(15, 0xcc));
  }
  topParts.push(fieldBytes(1, concatBytes(...chatModelParts)));

  return concatBytes(...topParts);
}

test('parseGenMetadataBlob extracts chatModel, usage, stepIndices, and chatStartMetadata', () => {
  const uncompactedBlob = buildGenMetadataBlob({
    model: 'gemini-2.5-pro',
    stepIndices: [5, 6, 7],
    fresh: 10806,
    output: 40,
    cacheRead: 122736,
    thinking: 22,
    response: 18,
    startStepIndex: 0xffffffffffffffffn,
    rowContext: 134225,
    rowLimit: 256000,
    includeSiblings: true,
  });

  const parsedUncompacted = parseGenMetadataBlob(4, uncompactedBlob);
  assert.ok(parsedUncompacted);
  assert.equal(parsedUncompacted.idx, 4);
  assert.deepEqual(parsedUncompacted.stepIndices, [5, 6, 7]);
  assert.equal(parsedUncompacted.model, 'gemini-2.5-pro');
  assert.equal(parsedUncompacted.fresh, 10806);
  assert.equal(parsedUncompacted.output, 40);
  assert.equal(parsedUncompacted.cacheRead, 122736);
  assert.equal(parsedUncompacted.thinking, 22);
  assert.equal(parsedUncompacted.response, 18);
  assert.equal(parsedUncompacted.effectiveContext, 134225);
  assert.equal(parsedUncompacted.contextLimit, 256000);
  assert.equal(parsedUncompacted.startStepIndex, null);
  assert.equal(parsedUncompacted.isCompacted, false);
  assert.equal(parsedUncompacted.compactedFromStep, null);
  assert.equal(parsedUncompacted.source, 'sqlite');

  const compactedBlob = buildGenMetadataBlob({
    model: 'claude-sonnet-4-5',
    stepIndices: [76, 77],
    packedStepIndices: false,
    fresh: 1200,
    output: 100,
    cacheRead: 25000,
    thinking: 60,
    response: 40,
    startStepIndex: 76,
    rowContext: 26300,
    rowLimit: 256000,
  });

  const parsedCompacted = parseGenMetadataBlob(5, compactedBlob);
  assert.ok(parsedCompacted);
  assert.deepEqual(parsedCompacted.stepIndices, [76, 77]);
  assert.equal(parsedCompacted.startStepIndex, 76);

  const zeroStartStepBlob = buildGenMetadataBlob({
    model: 'gemini-2.5-pro',
    fresh: 100,
    startStepIndex: 0,
  });
  const parsedZeroStart = parseGenMetadataBlob(0, zeroStartStepBlob);
  assert.ok(parsedZeroStart);
  assert.equal(parsedZeroStart.startStepIndex, 0);
});

test('parseGenMetadataBlob preserves DEFAULT_CONTEXT_LIMIT (256_000) and respects non-256k limits', () => {
  const missingLimitBlob = buildGenMetadataBlob({
    model: 'gemini-2.5-pro',
    fresh: 5000,
    cacheRead: 10000,
    rowContext: 15500,
  });
  const missingLimit = parseGenMetadataBlob(0, missingLimitBlob);
  assert.ok(missingLimit);
  assert.equal(missingLimit.contextLimit, DEFAULT_CONTEXT_LIMIT);
  assert.equal(missingLimit.contextLimit, 256_000);
  assert.notEqual(missingLimit.contextLimit, 255_000);

  const zeroLimitBlob = buildGenMetadataBlob({
    model: 'gemini-2.5-pro',
    fresh: 5000,
    rowLimit: 0,
  });
  const zeroLimit = parseGenMetadataBlob(1, zeroLimitBlob);
  assert.ok(zeroLimit);
  assert.equal(zeroLimit.contextLimit, 256_000);

  const limit200k = parseGenMetadataBlob(
    2,
    buildGenMetadataBlob({ model: 'claude-opus-4', fresh: 1000, rowLimit: 200_000 }),
  );
  assert.ok(limit200k);
  assert.equal(limit200k.contextLimit, 200_000);

  const limit1m = parseGenMetadataBlob(
    3,
    buildGenMetadataBlob({ model: 'gemini-2.5-pro', fresh: 1000, rowLimit: 1_000_000 }),
  );
  assert.ok(limit1m);
  assert.equal(limit1m.contextLimit, 1_000_000);
});

test('parseGenMetadataBlob handles effectiveContext fallback, omitted cacheRead, 64-bit BigInt, and negative/packed stepIndices', () => {
  const fallbackBlob = buildGenMetadataBlob({
    model: 'gemini-2.5-pro',
    fresh: 10806,
    cacheRead: 122736,
    thinking: 22,
    response: 18,
  });
  const fallbackPoint = parseGenMetadataBlob(0, fallbackBlob);
  assert.ok(fallbackPoint);
  assert.equal(fallbackPoint.effectiveContext, 10806 + 122736);
  assert.equal(fallbackPoint.output, 40);
  assert.equal(fallbackPoint.startStepIndex, null);

  const omittedCacheBlob = buildGenMetadataBlob({
    model: 'gemini-2.5-pro',
    fresh: 4200,
    output: 90,
  });
  const omittedCachePoint = parseGenMetadataBlob(1, omittedCacheBlob);
  assert.ok(omittedCachePoint);
  assert.equal(omittedCachePoint.cacheRead, 0);
  assert.equal(omittedCachePoint.effectiveContext, 4200);

  const large64BitBlob = buildGenMetadataBlob({
    model: 'gemini-2.5-pro',
    stepIndices: [-1n, -5n, 12n],
    fresh: 5_000_000_123n,
    cacheRead: 8_000_000_456n,
    startStepIndex: 0xffffffffffffffffn,
  });
  const large64BitPoint = parseGenMetadataBlob(2, large64BitBlob);
  assert.ok(large64BitPoint);
  assert.deepEqual(large64BitPoint.stepIndices, [-1, -5, 12]);
  assert.equal(large64BitPoint.fresh, 5_000_000_123);
  assert.equal(large64BitPoint.cacheRead, 8_000_000_456);
  assert.equal(large64BitPoint.effectiveContext, 13_000_000_579);
  assert.equal(large64BitPoint.startStepIndex, null);
});

test('parseGenMetadataBlob safely returns null on empty, missing chatModel, truncated, or malformed buffers', () => {
  assert.equal(parseGenMetadataBlob(0, new Uint8Array(0)), null);

  // Valid protobuf with stepIndices + executionId only, no Tag 1 chatModel
  const noChatModel = concatBytes(
    fieldPackedVarints(2, [1, 2]),
    fieldString(4, 'exec-only'),
  );
  assert.equal(parseGenMetadataBlob(0, noChatModel), null);

  // Empty Tag 1 chatModel
  assert.equal(parseGenMetadataBlob(0, fieldBytes(1, new Uint8Array(0))), null);

  // Truncated valid blob
  const valid = buildGenMetadataBlob({
    model: 'gemini-2.5-pro',
    fresh: 1000,
    cacheRead: 2000,
    rowLimit: 256_000,
  });
  assert.equal(parseGenMetadataBlob(0, valid.subarray(0, valid.length - 3)), null);
  assert.equal(parseGenMetadataBlob(0, valid.subarray(0, 2)), null);

  // Truncated varint (MSB set, no termination)
  assert.equal(parseGenMetadataBlob(0, Uint8Array.from([0x0a, 0x02, 0x08, 0x80])), null);

  // Overlong varint (>10 bytes)
  const overlongVarint = Uint8Array.from([
    0x0a, 13, 0x08,
    0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01,
  ]);
  assert.equal(parseGenMetadataBlob(0, overlongVarint), null);

  // 10th-byte 64-bit overflow (> 0x01)
  const overflow10thByte = Uint8Array.from([
    0x0a, 12, 0x22, 10, 0x10,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02,
  ]);
  assert.equal(parseGenMetadataBlob(0, overflow10thByte), null);

  // Unknown/invalid wire types (3, 4, 6, 7) and field number 0
  assert.equal(parseGenMetadataBlob(0, Uint8Array.from([0x0b])), null); // tag 1, wt 3
  assert.equal(parseGenMetadataBlob(0, Uint8Array.from([0x0c])), null); // tag 1, wt 4
  assert.equal(parseGenMetadataBlob(0, Uint8Array.from([0x0e])), null); // tag 1, wt 6
  assert.equal(parseGenMetadataBlob(0, Uint8Array.from([0x0f])), null); // tag 1, wt 7
  assert.equal(parseGenMetadataBlob(0, Uint8Array.from([0x00])), null); // tag 0

  // Truncated fixed64 (wt=1) and fixed32 (wt=5)
  assert.equal(parseGenMetadataBlob(0, Uint8Array.from([0x09, 1, 2, 3])), null);
  assert.equal(parseGenMetadataBlob(0, Uint8Array.from([0x0d, 1, 2])), null);

  // Length-delimited length exceeding remaining bytes
  assert.equal(parseGenMetadataBlob(0, Uint8Array.from([0x0a, 0x7f, 0x01, 0x02])), null);
});

test('parseSubagentRoleFromSummary extracts Tag 17 -> Tag 8 -> Tag 2 UTF-8 and handles malformed inputs safely', () => {
  const validSummary = concatBytes(
    fieldString(1, 'Conversation Title'),
    fieldVarint(3, 42),
    fieldFixed64(11),
    fieldFixed32(12),
    fieldBytes(
      17,
      concatBytes(
        fieldVarint(1, 7),
        fieldBytes(8, concatBytes(fieldVarint(1, 1), fieldString(2, 'Codebase 🔍 Researcher'))),
      ),
    ),
  );
  assert.equal(parseSubagentRoleFromSummary(validSummary), 'Codebase 🔍 Researcher');

  // Missing Tag 17
  assert.equal(parseSubagentRoleFromSummary(fieldString(1, 'No subagent metadata')), '');

  // Empty & malformed
  assert.equal(parseSubagentRoleFromSummary(new Uint8Array(0)), '');
  assert.equal(parseSubagentRoleFromSummary(validSummary.subarray(0, validSummary.length - 4)), '');
  assert.equal(parseSubagentRoleFromSummary(Uint8Array.from([0x8b, 0x01, 0xff])), '');
});

test('parseTrajectoryMetaBlob extracts deduplicated file:// URIs and paths safely', () => {
  const trajBlob = concatBytes(
    fieldBytes(
      1,
      concatBytes(
        fieldString(1, 'file:///home/user/repo-a'),
        fieldString(2, 'file:///home/user/repo-a'),
        fieldString(4, 'main'),
      ),
    ),
    fieldBytes(
      1,
      concatBytes(
        fieldString(1, 'vscode-remote://ssh-remote+dev/srv/repo-b'),
        fieldString(2, '/srv/repo-b'),
      ),
    ),
    fieldString(3, '02336c91-8a10-4f0b-aa1d-8116b429e89c'),
    fieldString(7, 'file:///home/user/repo-a'),
    fieldBytes(10, fieldBytes(17, fieldString(16, 'file:///home/user/repo-a/src/ignored-file.ts'))),
    fieldVarint(17, 1),
  );

  const meta = parseTrajectoryMetaBlob(trajBlob);
  assert.deepEqual(meta.workspaceUris, [
    'file:///home/user/repo-a',
    'vscode-remote://ssh-remote+dev/srv/repo-b',
    '/srv/repo-b',
  ]);

  // Windows path directly in Tag 1 & bare scheme rejection
  const winTraj = concatBytes(
    fieldBytes(1, encoder.encode('C:\\Users\\Dev\\Project')),
    fieldString(7, 'file://'),
  );
  assert.deepEqual(parseTrajectoryMetaBlob(winTraj), {
    workspaceUris: ['C:\\Users\\Dev\\Project'],
  });

  // Empty & malformed
  assert.deepEqual(parseTrajectoryMetaBlob(new Uint8Array(0)), { workspaceUris: [] });
  assert.deepEqual(parseTrajectoryMetaBlob(trajBlob.subarray(0, 5)), { workspaceUris: [] });
  assert.deepEqual(parseTrajectoryMetaBlob(Uint8Array.from([0x0e, 0xff])), { workspaceUris: [] });
});

test('hexToBytes and non-zero byteOffset Uint8Array sub-views decode cleanly', () => {
  assert.deepEqual(hexToBytes(''), new Uint8Array(0));
  assert.deepEqual(hexToBytes('0x0a02102a'), Uint8Array.from([0x0a, 0x02, 0x10, 0x2a]));
  assert.deepEqual(hexToBytes(' 0A02102A '), Uint8Array.from([0x0a, 0x02, 0x10, 0x2a]));
  assert.deepEqual(hexToBytes('abc'), new Uint8Array(0));
  assert.deepEqual(hexToBytes('zzzz'), new Uint8Array(0));

  const blob = buildGenMetadataBlob({
    model: 'gemini-2.5-flash',
    stepIndices: [1, 2],
    fresh: 500,
    cacheRead: 1500,
    output: 50,
  });
  const padded = new Uint8Array(blob.length + 10);
  padded.fill(0xff);
  padded.set(blob, 5);
  const subView = new Uint8Array(padded.buffer, 5, blob.length);
  const subDecoded = parseGenMetadataBlob(3, subView);
  assert.ok(subDecoded);
  assert.equal(subDecoded.idx, 3);
  assert.equal(subDecoded.model, 'gemini-2.5-flash');
  assert.equal(subDecoded.effectiveContext, 2000);

  const hex = Array.from(blob, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  const decoded = parseGenMetadataBlob(7, hexToBytes(hex));
  assert.ok(decoded);
  assert.equal(decoded.idx, 7);
  assert.equal(decoded.model, 'gemini-2.5-flash');
  assert.equal(decoded.effectiveContext, 2000);
  assert.equal(decoded.contextLimit, 256_000);
});
