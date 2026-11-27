/**
 * Protobuf wire encoding for Antigravity UnifiedStateSync entries in
 * `state.vscdb` (`ItemTable` keys `antigravityUnifiedStateSync.oauthToken`,
 * `antigravityUnifiedStateSync.userStatus`). Zero runtime dependencies; same
 * house style as `src/data/protobuf.ts` but write-oriented.
 *
 * Field maps are derived from observed standalone-IDE entries and are NOT
 * verified against a live Antigravity capture on this host (see
 * task-7-report residual risks). Every consumer therefore treats encoded
 * values as unverified until the IDE re-reads them after relaunch, and the
 * switch worker restores the `.bak` copy when the IDE-side state breaks.
 */

const WIRE_VARINT = 0;
const WIRE_LENGTH_DELIMITED = 2;
const MAX_VARINT_BYTES = 10;

const utf8Encoder = new TextEncoder();

function encodeVarint(value: bigint): number[] {
  let v = value < 0n ? BigInt.asUintN(64, value) : value;
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) {
      byte |= 0x80;
    }
    out.push(byte);
  } while (v > 0n);
  return out;
}

function fieldKey(fieldNumber: number, wireType: number): number[] {
  return encodeVarint(BigInt((fieldNumber << 3) | wireType));
}

function lengthDelimited(field: number, data: Uint8Array): Uint8Array {
  return new Uint8Array([...fieldKey(field, WIRE_LENGTH_DELIMITED), ...encodeVarint(BigInt(data.length)), ...data]);
}

function varintField(field: number, value: bigint): Uint8Array {
  return new Uint8Array([...fieldKey(field, WIRE_VARINT), ...encodeVarint(value)]);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// ---------- decoding (minimal scanner, mirrors data/protobuf.ts style) ----------

interface VarintRead {
  value: bigint;
  next: number;
}

function readVarintAt(buf: Uint8Array, offset: number): VarintRead | null {
  let value = 0n;
  let shift = 0n;
  for (let i = 0; i < MAX_VARINT_BYTES; i++) {
    if (offset + i >= buf.length) {
      return null;
    }
    const byte = buf[offset + i]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, next: offset + i + 1 };
    }
    shift += 7n;
  }
  return null;
}

interface DecodedField {
  fieldNumber: number;
  wireType: number;
  varint: bigint;
  start: number;
  end: number;
}

function scanMessage(buf: Uint8Array, start: number, end: number): DecodedField[] | null {
  const fields: DecodedField[] = [];
  let offset = start;
  while (offset < end) {
    const tag = readVarintAt(buf, offset);
    if (tag === null) {
      return null;
    }
    offset = tag.next;
    const wireType = Number(tag.value & 7n);
    const fieldNumber = Number(tag.value >> 3n);
    if (fieldNumber < 1) {
      return null;
    }
    if (wireType === WIRE_VARINT) {
      const val = readVarintAt(buf, offset);
      if (val === null) {
        return null;
      }
      offset = val.next;
      fields.push({ fieldNumber, wireType, varint: val.value, start: 0, end: 0 });
    } else if (wireType === WIRE_LENGTH_DELIMITED) {
      const len = readVarintAt(buf, offset);
      if (len === null || len.value > BigInt(end - len.next)) {
        return null;
      }
      const sliceStart = len.next;
      offset = sliceStart + Number(len.value);
      fields.push({ fieldNumber, wireType, varint: 0n, start: sliceStart, end: offset });
    } else {
      return null;
    }
  }
  return fields;
}

function decodeUtf8Slice(buf: Uint8Array, start: number, end: number): string {
  return Buffer.from(buf.subarray(start, end)).toString('utf8');
}

// ---------- OAuthInfo ----------

export interface OAuthInfoParams {
  accessToken: string;
  refreshToken: string;
  expirySeconds: number | bigint;
  idToken?: string;
  isGcpTos?: boolean;
  email?: string;
}

export interface DecodedOAuthInfo {
  accessToken: string;
  refreshToken: string;
  expirySeconds: bigint;
  idToken?: string;
  isGcpTos: boolean;
  email?: string;
}

const GMAIL_TOS_RE = /@(?:gmail|googlemail)\.com$/i;

/**
 * Encodes the OAuthInfo message carried inside the unified oauthToken entry.
 * Wire map: 1 access_token, 2 refresh_token, 3 expiry_seconds (int64 varint),
 * 4 id_token, 5 is_gcp_tos (bool, omitted when false), 6 email.
 * Gmail/Googlemail accounts are never under GCP ToS: the flag is forced off
 * regardless of caller input.
 */
export function encodeOAuthInfo(params: OAuthInfoParams): Uint8Array {
  const chunks: Uint8Array[] = [
    lengthDelimited(1, utf8Encoder.encode(params.accessToken)),
    lengthDelimited(2, utf8Encoder.encode(params.refreshToken)),
    varintField(3, BigInt(params.expirySeconds)),
  ];
  if (params.idToken) {
    chunks.push(lengthDelimited(4, utf8Encoder.encode(params.idToken)));
  }
  const isGcpTos = params.isGcpTos === true && !(params.email && GMAIL_TOS_RE.test(params.email));
  if (isGcpTos) {
    chunks.push(varintField(5, 1n));
  }
  if (params.email) {
    chunks.push(lengthDelimited(6, utf8Encoder.encode(params.email)));
  }
  return concatBytes(chunks);
}

/** Decodes an OAuthInfo message; null when malformed or missing access_token. */
export function decodeOAuthInfo(bytes: Uint8Array): DecodedOAuthInfo | null {
  const fields = scanMessage(bytes, 0, bytes.length);
  if (fields === null) {
    return null;
  }
  let accessToken = '';
  let refreshToken = '';
  let expirySeconds = 0n;
  let idToken: string | undefined;
  let isGcpTos = false;
  let email: string | undefined;
  for (const field of fields) {
    if (field.wireType === WIRE_LENGTH_DELIMITED) {
      const value = decodeUtf8Slice(bytes, field.start, field.end);
      if (field.fieldNumber === 1) {
        accessToken = value;
      } else if (field.fieldNumber === 2) {
        refreshToken = value;
      } else if (field.fieldNumber === 4) {
        idToken = value;
      } else if (field.fieldNumber === 6) {
        email = value;
      }
    } else if (field.wireType === WIRE_VARINT && field.fieldNumber === 3) {
      expirySeconds = field.varint;
    } else if (field.wireType === WIRE_VARINT && field.fieldNumber === 5) {
      isGcpTos = field.varint !== 0n;
    }
  }
  if (accessToken === '') {
    return null;
  }
  return {
    accessToken,
    refreshToken,
    expirySeconds,
    isGcpTos,
    ...(idToken !== undefined ? { idToken } : {}),
    ...(email !== undefined ? { email } : {}),
  };
}

// ---------- UnifiedStateSync entries ----------

export const OAUTH_TOKEN_SENTINEL_KEY = 'oauthTokenInfoSentinelKey';
export const USER_STATUS_SENTINEL_KEY = 'userStatusSentinelKey';

export interface DecodedUnifiedStateEntry {
  sentinelKey: string;
  payload: Uint8Array;
}

/**
 * Encodes one UnifiedStateSync entry value: a message with field 1 = sentinel
 * key and field 2 = payload bytes. Returns a latin1 ('binary') string so each
 * byte maps 1:1 to a char code — downstream string inspection
 * (`extractEmailFromIdeState` loose email scan) then sees plaintext fields.
 */
export function encodeUnifiedStateEntry(sentinelKey: string, payload: Uint8Array): string {
  const entry = concatBytes([
    lengthDelimited(1, utf8Encoder.encode(sentinelKey)),
    lengthDelimited(2, payload),
  ]);
  return Buffer.from(entry).toString('binary');
}

/** Decodes a UnifiedStateSync entry value (string or raw bytes); null on malformed input. */
export function decodeUnifiedStateEntry(value: string | Uint8Array): DecodedUnifiedStateEntry | null {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'binary') : Buffer.from(value);
  const fields = scanMessage(bytes, 0, bytes.length);
  if (fields === null) {
    return null;
  }
  let sentinelKey = '';
  let payload: Uint8Array | null = null;
  for (const field of fields) {
    if (field.wireType !== WIRE_LENGTH_DELIMITED) {
      continue;
    }
    if (field.fieldNumber === 1) {
      sentinelKey = decodeUtf8Slice(bytes, field.start, field.end);
    } else if (field.fieldNumber === 2) {
      payload = new Uint8Array(bytes.subarray(field.start, field.end));
    }
  }
  return payload === null ? null : { sentinelKey, payload };
}

/** Encodes the full `antigravityUnifiedStateSync.oauthToken` ItemTable value. */
export function encodeUnifiedOAuthToken(params: OAuthInfoParams): string {
  return encodeUnifiedStateEntry(OAUTH_TOKEN_SENTINEL_KEY, encodeOAuthInfo(params));
}

/**
 * Encodes the full `antigravityUnifiedStateSync.userStatus` ItemTable value.
 * Wire map (derived from observed standalone-IDE entries; unverified against a
 * live capture — see task-7-report): field 3 = account email (length-delimited),
 * field 7 = authenticated/active flag (varint 1).
 */
export function encodeUnifiedUserStatus(email: string): string {
  // Field 7 is encoded BEFORE field 3 so the plaintext email terminates the
  // buffer: a trailing field-7 tag byte would be ASCII '8' and the loose email
  // scan in extractEmailFromIdeState would absorb it into the domain.
  const payload = concatBytes([varintField(7, 1n), lengthDelimited(3, utf8Encoder.encode(email))]);
  return encodeUnifiedStateEntry(USER_STATUS_SENTINEL_KEY, payload);
}
