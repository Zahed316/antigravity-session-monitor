import { DEFAULT_CONTEXT_LIMIT, type CallUsagePoint } from '../types.ts';

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

const MAX_VARINT_BYTES = 10;
const MAX_FIELD_NUMBER = 0x1fffffffn;
const UINT64_SENTINEL = 0xffffffffffffffffn;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_URI_SCAN_BYTES = 4096;

const WORKSPACE_URI_RE =
  /^(?:(?:file|vscode-remote|vscode-vfs):\/\/[^\x00-\x1f\x7f]+|\/(?!\/)[^\x00-\x1f\x7f]+|[A-Za-z]:[\\/][^\x00-\x1f\x7f]*|\\\\[^\\\/\x00-\x1f\x7f]+[\\/][^\x00-\x1f\x7f]+)/;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

interface VarintRead {
  value: bigint;
  nextOffset: number;
}

type FieldVisitor = (
  fieldNumber: number,
  wireType: number,
  varintValue: bigint,
  sliceStart: number,
  sliceEnd: number,
) => boolean | void;

interface MutableChatModel {
  hasChatModel: boolean;
  hasUsage: boolean;
  hasChatStartMetadata: boolean;
  model: string;
  fresh: number;
  rawOutput: number;
  cacheRead: number;
  thinking: number;
  response: number;
  startStepIndex: number | null;
  rowContext: number | null;
  rowLimit: number | null;
}

function hexNibble(code: number): number {
  if (code >= 48 && code <= 57) {
    return code - 48;
  }
  if (code >= 65 && code <= 70) {
    return code - 55;
  }
  if (code >= 97 && code <= 102) {
    return code - 87;
  }
  return -1;
}

/**
 * Decodes a hex string (such as SQLite `hex(blob)` output) into raw bytes.
 * Returns an empty `Uint8Array` on empty, odd-length, or malformed input.
 */
export function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== 'string') {
    return new Uint8Array(0);
  }
  let clean = hex.trim();
  if (clean.startsWith('0x') || clean.startsWith('0X')) {
    clean = clean.slice(2);
  }
  if (clean.length === 0 || clean.length % 2 !== 0) {
    return new Uint8Array(0);
  }

  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    const hi = hexNibble(clean.charCodeAt(i));
    const lo = hexNibble(clean.charCodeAt(i + 1));
    if (hi < 0 || lo < 0) {
      return new Uint8Array(0);
    }
    out[i / 2] = (hi << 4) | lo;
  }
  return out;
}

function readVarint(buf: Uint8Array, offset: number, end: number): VarintRead | null {
  let value = 0n;
  let shift = 0n;

  for (let i = 0; i < MAX_VARINT_BYTES; i++) {
    if (offset >= end) {
      return null;
    }
    const byte = buf[offset++];
    // 64-bit varints cannot exceed 10 bytes, and the 10th byte carries at most bit 63 (0x01).
    if (i === MAX_VARINT_BYTES - 1 && ((byte & 0x80) !== 0 || byte > 0x01)) {
      return null;
    }
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, nextOffset: offset };
    }
    shift += 7n;
  }

  return null;
}

function scanFields(
  buf: Uint8Array,
  start: number,
  end: number,
  onField: FieldVisitor,
): boolean {
  let offset = start;

  while (offset < end) {
    const tag = readVarint(buf, offset, end);
    if (tag === null) {
      return false;
    }
    offset = tag.nextOffset;

    const wireType = Number(tag.value & 7n);
    const fieldNumberBig = tag.value >> 3n;
    if (fieldNumberBig < 1n || fieldNumberBig > MAX_FIELD_NUMBER) {
      return false;
    }
    const fieldNumber = Number(fieldNumberBig);

    if (wireType === WIRE_VARINT) {
      const val = readVarint(buf, offset, end);
      if (val === null) {
        return false;
      }
      offset = val.nextOffset;
      if (onField(fieldNumber, wireType, val.value, 0, 0) === false) {
        return false;
      }
    } else if (wireType === WIRE_FIXED64) {
      if (end - offset < 8) {
        return false;
      }
      const sliceStart = offset;
      offset += 8;
      if (onField(fieldNumber, wireType, 0n, sliceStart, offset) === false) {
        return false;
      }
    } else if (wireType === WIRE_LENGTH_DELIMITED) {
      const len = readVarint(buf, offset, end);
      if (len === null) {
        return false;
      }
      offset = len.nextOffset;
      if (len.value > BigInt(end - offset)) {
        return false;
      }
      const sliceStart = offset;
      offset += Number(len.value);
      if (onField(fieldNumber, wireType, 0n, sliceStart, offset) === false) {
        return false;
      }
    } else if (wireType === WIRE_FIXED32) {
      if (end - offset < 4) {
        return false;
      }
      const sliceStart = offset;
      offset += 4;
      if (onField(fieldNumber, wireType, 0n, sliceStart, offset) === false) {
        return false;
      }
    } else {
      return false;
    }
  }

  return true;
}

function toSignedSafeInt(raw: bigint): number {
  const signed = BigInt.asIntN(64, raw);
  if (signed > MAX_SAFE_BIGINT) {
    return Number.MAX_SAFE_INTEGER;
  }
  if (signed < -MAX_SAFE_BIGINT) {
    return -Number.MAX_SAFE_INTEGER;
  }
  return Number(signed);
}

function toNonNegativeSafeInt(raw: bigint): number {
  const signed = BigInt.asIntN(64, raw);
  if (signed <= 0n) {
    return 0;
  }
  if (signed > MAX_SAFE_BIGINT) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Number(signed);
}

function decodeUtf8(buf: Uint8Array, start: number, end: number): string {
  return utf8Decoder.decode(buf.subarray(start, end));
}

function tryDecodeUtf8(buf: Uint8Array, start: number, end: number): string | null {
  try {
    return strictUtf8Decoder.decode(buf.subarray(start, end));
  } catch {
    return null;
  }
}

function isWorkspaceUriOrPath(value: string): boolean {
  if (value.length === 0 || CONTROL_CHAR_RE.test(value)) {
    return false;
  }
  return WORKSPACE_URI_RE.test(value);
}

function decodePackedStepIndices(
  buf: Uint8Array,
  start: number,
  end: number,
  out: number[],
): boolean {
  let offset = start;
  while (offset < end) {
    const val = readVarint(buf, offset, end);
    if (val === null) {
      return false;
    }
    out.push(toSignedSafeInt(val.value));
    offset = val.nextOffset;
  }
  return true;
}

function parseUsageMessage(
  buf: Uint8Array,
  start: number,
  end: number,
  state: MutableChatModel,
): boolean {
  state.hasUsage = true;
  return scanFields(buf, start, end, (fieldNumber, wireType, varintValue) => {
    if (wireType !== WIRE_VARINT) {
      return;
    }
    switch (fieldNumber) {
      case 2:
        state.fresh = toNonNegativeSafeInt(varintValue);
        break;
      case 3:
        state.rawOutput = toNonNegativeSafeInt(varintValue);
        break;
      case 5:
        state.cacheRead = toNonNegativeSafeInt(varintValue);
        break;
      case 9:
        state.thinking = toNonNegativeSafeInt(varintValue);
        break;
      case 10:
        state.response = toNonNegativeSafeInt(varintValue);
        break;
    }
  });
}

function parseContextWindowMetadata(
  buf: Uint8Array,
  start: number,
  end: number,
  state: MutableChatModel,
): boolean {
  return scanFields(buf, start, end, (fieldNumber, wireType, varintValue) => {
    if (wireType !== WIRE_VARINT) {
      return;
    }
    const signed = BigInt.asIntN(64, varintValue);
    if (signed < 0n) {
      return;
    }
    if (fieldNumber === 1) {
      state.rowContext = toNonNegativeSafeInt(varintValue);
    } else if (fieldNumber === 4) {
      state.rowLimit = toNonNegativeSafeInt(varintValue);
    }
  });
}

function parseChatStartMetadata(
  buf: Uint8Array,
  start: number,
  end: number,
  state: MutableChatModel,
): boolean {
  state.hasChatStartMetadata = true;
  return scanFields(buf, start, end, (fieldNumber, wireType, varintValue, sliceStart, sliceEnd) => {
    if (fieldNumber === 2 && wireType === WIRE_VARINT) {
      if (varintValue === UINT64_SENTINEL || BigInt.asIntN(64, varintValue) < 0n) {
        state.startStepIndex = null;
      } else {
        state.startStepIndex = toNonNegativeSafeInt(varintValue);
      }
    } else if (fieldNumber === 10 && wireType === WIRE_LENGTH_DELIMITED) {
      return parseContextWindowMetadata(buf, sliceStart, sliceEnd, state);
    }
  });
}

function parseChatModel(
  buf: Uint8Array,
  start: number,
  end: number,
  state: MutableChatModel,
): boolean {
  state.hasChatModel = true;
  return scanFields(buf, start, end, (fieldNumber, wireType, _val, sliceStart, sliceEnd) => {
    if (wireType !== WIRE_LENGTH_DELIMITED) {
      return;
    }
    if (fieldNumber === 19) {
      state.model = decodeUtf8(buf, sliceStart, sliceEnd);
    } else if (fieldNumber === 4) {
      return parseUsageMessage(buf, sliceStart, sliceEnd, state);
    } else if (fieldNumber === 9) {
      return parseChatStartMetadata(buf, sliceStart, sliceEnd, state);
    }
  });
}

/**
 * Decodes a single `gen_metadata.data` protobuf blob into a `CallUsagePoint`.
 * Returns `null` if the buffer is empty, malformed/truncated, or lacks usable `chatModel` data.
 */
export function parseGenMetadataBlob(idx: number, buf: Uint8Array): CallUsagePoint | null {
  if (!(buf instanceof Uint8Array) || buf.length === 0) {
    return null;
  }

  const stepIndices: number[] = [];
  const state: MutableChatModel = {
    hasChatModel: false,
    hasUsage: false,
    hasChatStartMetadata: false,
    model: '',
    fresh: 0,
    rawOutput: 0,
    cacheRead: 0,
    thinking: 0,
    response: 0,
    startStepIndex: null,
    rowContext: null,
    rowLimit: null,
  };

  const ok = scanFields(buf, 0, buf.length, (fieldNumber, wireType, varintValue, sliceStart, sliceEnd) => {
    if (fieldNumber === 1 && wireType === WIRE_LENGTH_DELIMITED) {
      return parseChatModel(buf, sliceStart, sliceEnd, state);
    }
    if (fieldNumber === 2) {
      if (wireType === WIRE_VARINT) {
        stepIndices.push(toSignedSafeInt(varintValue));
      } else if (wireType === WIRE_LENGTH_DELIMITED) {
        return decodePackedStepIndices(buf, sliceStart, sliceEnd, stepIndices);
      }
    }
  });

  if (!ok || !state.hasChatModel) {
    return null;
  }
  if (!state.hasUsage && !state.hasChatStartMetadata && state.model.length === 0) {
    return null;
  }

  const output = state.rawOutput > 0 ? state.rawOutput : state.thinking + state.response;
  const effectiveContext =
    state.rowContext !== null && state.rowContext > 0
      ? state.rowContext
      : state.fresh + state.cacheRead;
  const contextLimit =
    state.rowLimit !== null && state.rowLimit > 0 ? state.rowLimit : DEFAULT_CONTEXT_LIMIT;

  return {
    idx,
    stepIndices,
    model: state.model,
    fresh: state.fresh,
    cacheRead: state.cacheRead,
    output,
    thinking: state.thinking,
    response: state.response,
    effectiveContext,
    contextLimit,
    startStepIndex: state.startStepIndex,
    isCompacted: false,
    compactedFromStep: null,
    source: 'sqlite',
  };
}

/**
 * Extracts the subagent role string from `conversation_summaries.raw_summary` (`Tag 17 -> Tag 8 -> Tag 2`).
 * Returns `""` when absent, empty, or malformed/truncated.
 */
export function parseSubagentRoleFromSummary(rawSummary: Uint8Array): string {
  if (!(rawSummary instanceof Uint8Array) || rawSummary.length === 0) {
    return '';
  }

  let role = '';

  const ok = scanFields(rawSummary, 0, rawSummary.length, (fn17, wt17, _v17, s17, e17) => {
    if (fn17 !== 17 || wt17 !== WIRE_LENGTH_DELIMITED) {
      return;
    }
    return scanFields(rawSummary, s17, e17, (fn8, wt8, _v8, s8, e8) => {
      if (fn8 !== 8 || wt8 !== WIRE_LENGTH_DELIMITED) {
        return;
      }
      return scanFields(rawSummary, s8, e8, (fn2, wt2, _v2, s2, e2) => {
        if (fn2 === 2 && wt2 === WIRE_LENGTH_DELIMITED) {
          const decoded = decodeUtf8(rawSummary, s2, e2).trim();
          if (decoded.length > 0) {
            role = decoded;
          }
        }
      });
    });
  });

  return ok ? role : '';
}

/**
 * Extracts deduplicated workspace URIs or paths from `trajectory_metadata_blob.data`.
 * Returns `{ workspaceUris: [] }` on empty, malformed, or truncated buffers.
 */
export function parseTrajectoryMetaBlob(
  buf: Uint8Array,
): { title?: string; workspaceUris: string[] } {
  if (!(buf instanceof Uint8Array) || buf.length === 0) {
    return { workspaceUris: [] };
  }

  const uris = new Set<string>();

  const ok = scanFields(buf, 0, buf.length, (fieldNumber, wireType, _v, sliceStart, sliceEnd) => {
    if (wireType !== WIRE_LENGTH_DELIMITED) {
      return;
    }

    if (sliceEnd - sliceStart <= MAX_URI_SCAN_BYTES) {
      const direct = tryDecodeUtf8(buf, sliceStart, sliceEnd);
      if (direct !== null && isWorkspaceUriOrPath(direct)) {
        uris.add(direct);
        return;
      }
    }

    // Tag 1 holds repeated WorkspaceMetadata messages (1: workspaceFolderAbsoluteUri, 2: gitRootAbsoluteUri).
    if (fieldNumber === 1) {
      return scanFields(buf, sliceStart, sliceEnd, (_subFn, subWt, _sv, subStart, subEnd) => {
        if (subWt !== WIRE_LENGTH_DELIMITED || subEnd - subStart > MAX_URI_SCAN_BYTES) {
          return;
        }
        const nested = tryDecodeUtf8(buf, subStart, subEnd);
        if (nested !== null && isWorkspaceUriOrPath(nested)) {
          uris.add(nested);
        }
      });
    }
  });

  return ok ? { workspaceUris: Array.from(uris) } : { workspaceUris: [] };
}
