import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type * as nodeSqlite from 'node:sqlite';
import { hexToBytes } from './protobuf.ts';

export type SqliteBackend = 'node:sqlite' | 'sqlite3-cli' | 'python3';

export type SqliteParam = string | number;

export interface ExecFileOptions {
  timeout?: number;
  maxBuffer?: number;
  encoding?: BufferEncoding;
  windowsHide?: boolean;
}

export interface ExecFileResult {
  stdout: string | Buffer;
  stderr: string | Buffer;
}

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options?: ExecFileOptions,
) => Promise<ExecFileResult>;

export interface SqliteClient {
  backend: SqliteBackend;
  queryAll<T>(
    dbPath: string,
    sql: string,
    params?: ReadonlyArray<string | number>,
  ): Promise<T[]>;
  dispose(): void;
}

export interface CreateSqliteClientOptions {
  forceCliFallback?: boolean;
  sqlite3Path?: string;
  pythonCandidates?: string[];
  execFileFn?: ExecFileLike;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  commandTimeoutMs?: number;
  maxBufferBytes?: number;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const NODE_SQLITE_BUSY_TIMEOUT_MS = 5_000;

const WIN_PYTHON_VERSIONS = ['314', '313', '312', '311', '310', '39', '38'];

const WINDOWS_STORE_STUB_RE =
  /microsoft\s+store|python\s+was\s+not\s+found|app\s+execution\s+aliases/i;
const PYTHON_3_VERSION_RE = /^Python\s+3(?:\.\d+)?/i;
const SQLITE_VERSION_RE = /\b(\d+)\.(\d+)(?:\.\d+)?\b/;
const WRITE_SQL_LEADING_RE =
  /^(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|DETACH|VACUUM|REINDEX)\b/i;

const PYTHON_QUERY_SCRIPT = [
  'import base64, json, sqlite3, sys',
  'uri, sql, params_json = sys.argv[1], sys.argv[2], sys.argv[3]',
  'params = json.loads(params_json)',
  'conn = sqlite3.connect(uri, uri=True, timeout=5.0)',
  'try:',
  '    cur = conn.execute(sql, params)',
  '    cols = [d[0] for d in (cur.description or [])]',
  '    rows = []',
  '    for row in cur:',
  '        obj = {}',
  '        for k, v in zip(cols, row):',
  '            if isinstance(v, (bytes, bytearray, memoryview)):',
  '                obj[k] = {"__sqlite_blob_b64__": base64.b64encode(bytes(v)).decode("ascii")}',
  '            else:',
  '                obj[k] = v',
  '        rows.append(obj)',
  '    sys.stdout.write(json.dumps(rows))',
  'finally:',
  '    conn.close()',
].join('\n');

const execFileAsync = promisify(execFile);

function createDefaultExecFile(): ExecFileLike {
  return async (file, args, options) => {
    const res = await execFileAsync(file, args, {
      encoding: options?.encoding ?? 'utf8',
      timeout: options?.timeout,
      maxBuffer: options?.maxBuffer,
      windowsHide: options?.windowsHide ?? true,
    });
    return {
      stdout: res.stdout,
      stderr: res.stderr,
    };
  };
}

function pushUnique(list: string[], seen: Set<string>, candidate: string | undefined): void {
  if (!candidate) {
    return;
  }
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || seen.has(trimmed)) {
    return;
  }
  seen.add(trimmed);
  list.push(trimmed);
}

function collectWindowsCandidates(
  env: NodeJS.ProcessEnv,
  homeDir: string,
): { sqlite3: string[]; python: string[] } {
  const winPath = path.win32;
  const sqlite3: string[] = [];
  const python: string[] = [];
  const seenSql = new Set<string>();
  const seenPy = new Set<string>();

  const localAppData = env.LOCALAPPDATA ?? env.LocalAppData ?? (homeDir ? winPath.join(homeDir, 'AppData', 'Local') : '');
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files';
  const userProfile = env.USERPROFILE ?? env.UserProfile ?? homeDir;
  const chocoInstall = env.ChocolateyInstall ?? 'C:\\ProgramData\\chocolatey';

  pushUnique(sqlite3, seenSql, 'sqlite3.exe');
  pushUnique(sqlite3, seenSql, 'sqlite3');
  if (env.ANDROID_HOME) {
    pushUnique(sqlite3, seenSql, winPath.join(env.ANDROID_HOME, 'platform-tools', 'sqlite3.exe'));
  }
  if (env.ANDROID_SDK_ROOT) {
    pushUnique(sqlite3, seenSql, winPath.join(env.ANDROID_SDK_ROOT, 'platform-tools', 'sqlite3.exe'));
  }
  if (homeDir) {
    pushUnique(sqlite3, seenSql, winPath.join(homeDir, 'Android', 'Sdk', 'platform-tools', 'sqlite3.exe'));
  }
  if (localAppData) {
    pushUnique(sqlite3, seenSql, winPath.join(localAppData, 'Android', 'Sdk', 'platform-tools', 'sqlite3.exe'));
    pushUnique(sqlite3, seenSql, winPath.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'sqlite3.exe'));
  }
  if (userProfile) {
    pushUnique(sqlite3, seenSql, winPath.join(userProfile, 'scoop', 'shims', 'sqlite3.exe'));
  }
  pushUnique(sqlite3, seenSql, winPath.join(chocoInstall, 'bin', 'sqlite3.exe'));
  pushUnique(sqlite3, seenSql, winPath.join(programFiles, 'SQLite', 'sqlite3.exe'));
  pushUnique(sqlite3, seenSql, 'C:\\sqlite\\sqlite3.exe');

  pushUnique(python, seenPy, 'python3.exe');
  pushUnique(python, seenPy, 'python.exe');
  pushUnique(python, seenPy, 'python3');
  pushUnique(python, seenPy, 'python');
  for (const ver of WIN_PYTHON_VERSIONS) {
    if (localAppData) {
      pushUnique(python, seenPy, winPath.join(localAppData, 'Programs', 'Python', `Python${ver}`, 'python.exe'));
    }
    pushUnique(python, seenPy, winPath.join(programFiles, `Python${ver}`, 'python.exe'));
    pushUnique(python, seenPy, `C:\\Python${ver}\\python.exe`);
  }
  if (userProfile) {
    pushUnique(python, seenPy, winPath.join(userProfile, 'scoop', 'shims', 'python3.exe'));
    pushUnique(python, seenPy, winPath.join(userProfile, 'scoop', 'shims', 'python.exe'));
  }

  return { sqlite3, python };
}

function collectPosixCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): { sqlite3: string[]; python: string[] } {
  const posixPath = path.posix;
  const sqlite3: string[] = [];
  const python: string[] = [];
  const seenSql = new Set<string>();
  const seenPy = new Set<string>();

  pushUnique(sqlite3, seenSql, 'sqlite3');
  if (platform === 'darwin') {
    pushUnique(sqlite3, seenSql, '/opt/homebrew/bin/sqlite3');
    pushUnique(sqlite3, seenSql, '/opt/homebrew/opt/sqlite/bin/sqlite3');
    pushUnique(sqlite3, seenSql, '/usr/local/bin/sqlite3');
    pushUnique(sqlite3, seenSql, '/usr/local/opt/sqlite/bin/sqlite3');
    pushUnique(sqlite3, seenSql, '/usr/bin/sqlite3');
  } else {
    pushUnique(sqlite3, seenSql, '/home/linuxbrew/.linuxbrew/bin/sqlite3');
    pushUnique(sqlite3, seenSql, '/home/linuxbrew/.linuxbrew/opt/sqlite/bin/sqlite3');
    if (homeDir) {
      pushUnique(sqlite3, seenSql, posixPath.join(homeDir, '.linuxbrew', 'bin', 'sqlite3'));
    }
    pushUnique(sqlite3, seenSql, '/usr/local/bin/sqlite3');
    pushUnique(sqlite3, seenSql, '/usr/bin/sqlite3');
    pushUnique(sqlite3, seenSql, '/bin/sqlite3');
  }

  if (env.ANDROID_HOME) {
    pushUnique(sqlite3, seenSql, posixPath.join(env.ANDROID_HOME, 'platform-tools', 'sqlite3'));
  }
  if (env.ANDROID_SDK_ROOT) {
    pushUnique(sqlite3, seenSql, posixPath.join(env.ANDROID_SDK_ROOT, 'platform-tools', 'sqlite3'));
  }
  if (homeDir) {
    pushUnique(sqlite3, seenSql, posixPath.join(homeDir, 'Android', 'Sdk', 'platform-tools', 'sqlite3'));
    if (platform === 'darwin') {
      pushUnique(sqlite3, seenSql, posixPath.join(homeDir, 'Library', 'Android', 'sdk', 'platform-tools', 'sqlite3'));
    }
  }

  pushUnique(python, seenPy, 'python3');
  pushUnique(python, seenPy, 'python');
  if (platform === 'darwin') {
    pushUnique(python, seenPy, '/opt/homebrew/bin/python3');
    pushUnique(python, seenPy, '/usr/local/bin/python3');
    pushUnique(python, seenPy, '/Library/Frameworks/Python.framework/Versions/Current/bin/python3');
    pushUnique(python, seenPy, '/usr/bin/python3');
  } else {
    pushUnique(python, seenPy, '/home/linuxbrew/.linuxbrew/bin/python3');
    if (homeDir) {
      pushUnique(python, seenPy, posixPath.join(homeDir, '.linuxbrew', 'bin', 'python3'));
    }
    pushUnique(python, seenPy, '/usr/local/bin/python3');
    pushUnique(python, seenPy, '/usr/bin/python3');
    pushUnique(python, seenPy, '/bin/python3');
  }
  if (homeDir) {
    pushUnique(python, seenPy, posixPath.join(homeDir, '.pyenv', 'shims', 'python3'));
  }

  return { sqlite3, python };
}

/**
 * Resolves ordered binary probe candidates for `sqlite3` and `python3`
 * across Linux, macOS, and Windows (including Android SDK and Homebrew paths).
 */
export function resolveBinaryCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): { sqlite3: string[]; python: string[] } {
  if (platform === 'win32') {
    return collectWindowsCandidates(env, homeDir);
  }
  return collectPosixCandidates(platform, env, homeDir);
}

function validateSqlAndParams(
  sql: string,
  params: ReadonlyArray<string | number> | undefined,
): ReadonlyArray<string | number> {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new Error('SQL query must be a non-empty string');
  }
  if (sql.includes('\0')) {
    throw new Error('SQL query cannot contain NUL byte');
  }
  const bound = params ?? [];
  for (let i = 0; i < bound.length; i++) {
    const val = bound[i];
    if (typeof val === 'number') {
      if (!Number.isFinite(val)) {
        throw new Error(`Invalid SQL parameter at index ${i}: expected finite number`);
      }
    } else if (typeof val !== 'string') {
      throw new Error(`Invalid SQL parameter at index ${i}: expected string or number`);
    }
  }
  return bound;
}

function formatCliSqlParam(param: string | number): string {
  if (typeof param === 'number') {
    return Object.is(param, -0) ? '0' : String(param);
  }
  if (param.includes('\0')) {
    throw new Error('SQLite CLI string parameter cannot contain NUL byte');
  }
  return `'${param.replace(/'/g, "''")}'`;
}

function findClosingDoubleChar(sql: string, start: number, quoteChar: string): number {
  let i = start;
  while (i < sql.length) {
    if (sql[i] === quoteChar) {
      if (sql[i + 1] === quoteChar) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return -1;
}

function scanAndBindSql(
  sql: string,
  params: ReadonlyArray<string | number>,
  bindParams: boolean,
): string {
  const parts: string[] = [];
  let segmentStart = 0;
  let paramIdx = 0;
  let firstCodeChar = '';
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    if (ch === "'" || ch === '"' || ch === '`') {
      if (!firstCodeChar) {
        firstCodeChar = ch;
      }
      const next = findClosingDoubleChar(sql, i + 1, ch);
      if (next < 0) {
        throw new Error(`Unterminated SQL literal starting with ${ch}`);
      }
      i = next;
      continue;
    }

    if (ch === '[') {
      if (!firstCodeChar) {
        firstCodeChar = ch;
      }
      const closeIdx = sql.indexOf(']', i + 1);
      if (closeIdx < 0) {
        throw new Error('Unterminated SQL bracket identifier');
      }
      i = closeIdx + 1;
      continue;
    }

    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      i = nl < 0 ? sql.length : nl + 1;
      continue;
    }

    if (ch === '/' && sql[i + 1] === '*') {
      const closeIdx = sql.indexOf('*/', i + 2);
      if (closeIdx < 0) {
        throw new Error('Unterminated SQL block comment');
      }
      i = closeIdx + 2;
      continue;
    }

    if (!firstCodeChar && !/\s/.test(ch)) {
      firstCodeChar = ch;
    }

    if (ch === '?') {
      const nextChar = sql[i + 1];
      if (nextChar !== undefined && nextChar >= '0' && nextChar <= '9') {
        throw new Error('Numbered SQL parameters (?N) are not supported');
      }
      if (paramIdx >= params.length) {
        throw new Error('SQL parameter count mismatch: more placeholders than parameters');
      }
      const val = params[paramIdx++];
      if (bindParams) {
        parts.push(sql.slice(segmentStart, i), formatCliSqlParam(val));
        segmentStart = i + 1;
      }
    }

    i++;
  }

  if (paramIdx !== params.length) {
    throw new Error(
      `SQL parameter count mismatch: expected ${paramIdx}, got ${params.length}`,
    );
  }

  if (bindParams && firstCodeChar === '.') {
    throw new Error('SQLite CLI dot-commands are not permitted');
  }

  if (!bindParams) {
    return sql;
  }
  parts.push(sql.slice(segmentStart));
  return parts.join('');
}

function stripLeadingSqlComments(sql: string): string {
  let i = 0;
  while (i < sql.length) {
    if (/\s/.test(sql[i])) {
      i++;
      continue;
    }
    if (sql[i] === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      i = nl < 0 ? sql.length : nl + 1;
      continue;
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) {
        break;
      }
      i = end + 2;
      continue;
    }
    break;
  }
  return sql.slice(i);
}

function isWriteSql(sql: string): boolean {
  return WRITE_SQL_LEADING_RE.test(stripLeadingSqlComments(sql));
}

function toSqliteFileUri(dbPath: string, immutable: boolean): string {
  if (dbPath === ':memory:') {
    return ':memory:';
  }
  const suffix = immutable ? '?mode=ro&immutable=1' : '?mode=ro';
  if (dbPath.startsWith('file:')) {
    return dbPath.includes('?') ? `${dbPath}&${suffix.slice(1)}` : `${dbPath}${suffix}`;
  }
  if (/^[A-Za-z]:[\\/]/.test(dbPath) && process.platform !== 'win32') {
    const slashPath = dbPath.replace(/\\/g, '/');
    const encoded = encodeURI(slashPath).replace(/#/g, '%23').replace(/\?/g, '%3F');
    return `file:///${encoded}${suffix}`;
  }
  return `${pathToFileURL(path.resolve(dbPath)).href}${suffix}`;
}

async function statPathState(filePath: string): Promise<'exists' | 'missing' | 'inaccessible'> {
  try {
    await fs.stat(filePath);
    return 'exists';
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return 'missing';
    }
    return 'inaccessible';
  }
}

function toUtf8Text(value: string | Buffer | undefined): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }
  return '';
}

function extractErrorText(err: unknown): string {
  if (!err || typeof err !== 'object') {
    return String(err ?? '');
  }
  const obj = err as { message?: unknown; stderr?: unknown; stdout?: unknown };
  const parts: string[] = [];
  if (typeof obj.message === 'string') {
    parts.push(obj.message);
  }
  const stderr = toUtf8Text(obj.stderr as string | Buffer | undefined);
  if (stderr) {
    parts.push(stderr);
  }
  const stdout = toUtf8Text(obj.stdout as string | Buffer | undefined);
  if (stdout) {
    parts.push(stdout);
  }
  return parts.join('\n');
}

function isMissingDbError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return true;
  }
  const errcode = (err as { errcode?: unknown })?.errcode;
  if (errcode === 14) {
    return true;
  }
  return /unable to open database/i.test(extractErrorText(err));
}

function isReadonlyDirectoryError(err: unknown): boolean {
  const errcode = (err as { errcode?: unknown })?.errcode;
  if (errcode === 1544 || errcode === 14) {
    return true;
  }
  return /attempt to write a readonly database|unable to open database/i.test(
    extractErrorText(err),
  );
}

async function runWithMissingAndImmutableFallback<T>(
  dbPath: string,
  sql: string,
  allowPreStat: boolean,
  runner: (immutable: boolean) => Promise<T[]>,
): Promise<T[]> {
  const isSpecialPath = dbPath === ':memory:' || dbPath.startsWith('file:');

  if (allowPreStat && !isSpecialPath) {
    const state = await statPathState(dbPath);
    if (state === 'missing') {
      return [];
    }
  }

  try {
    return await runner(false);
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return [];
    }

    if (!isSpecialPath) {
      const state = await statPathState(dbPath);
      if (state === 'missing' && isMissingDbError(err)) {
        return [];
      }
      if (state === 'exists' && !isWriteSql(sql) && isReadonlyDirectoryError(err)) {
        return await runner(true);
      }
    }

    throw err;
  }
}

async function loadAndProbeNodeSqlite(): Promise<typeof nodeSqlite | null> {
  try {
    const mod = (await import('node:sqlite')) as typeof nodeSqlite;
    if (typeof mod?.DatabaseSync !== 'function') {
      return null;
    }
    const probeDb = new mod.DatabaseSync(':memory:', { readOnly: true });
    let readOnlyEnforced = false;
    try {
      probeDb.exec('CREATE TABLE _probe (x INT)');
    } catch (err) {
      if (/readonly/i.test(extractErrorText(err))) {
        readOnlyEnforced = true;
      }
    } finally {
      probeDb.close();
    }
    return readOnlyEnforced ? mod : null;
  } catch {
    return null;
  }
}

async function probeSqlite3Binary(
  candidate: string,
  execFileFn: ExecFileLike,
  execOpts: ExecFileOptions,
): Promise<boolean> {
  try {
    const res = await execFileFn(candidate, ['--version'], execOpts);
    const stdout = toUtf8Text(res.stdout).trim();
    const stderr = toUtf8Text(res.stderr).trim();
    if (!stdout || WINDOWS_STORE_STUB_RE.test(`${stdout}\n${stderr}`)) {
      return false;
    }
    const versionMatch = SQLITE_VERSION_RE.exec(stdout);
    if (versionMatch) {
      const major = Number(versionMatch[1]);
      const minor = Number(versionMatch[2]);
      if (major < 3 || (major === 3 && minor < 33)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function probePythonBinary(
  candidate: string,
  execFileFn: ExecFileLike,
  execOpts: ExecFileOptions,
): Promise<boolean> {
  try {
    const res = await execFileFn(candidate, ['--version'], execOpts);
    const stdout = toUtf8Text(res.stdout).trim();
    const stderr = toUtf8Text(res.stderr).trim();
    if (!stdout || WINDOWS_STORE_STUB_RE.test(`${stdout}\n${stderr}`)) {
      return false;
    }
    return PYTHON_3_VERSION_RE.test(stdout);
  } catch {
    return false;
  }
}

function createNodeSqliteClient(sqliteMod: typeof nodeSqlite): SqliteClient {
  let disposed = false;

  const queryTarget = <T>(
    target: string,
    sql: string,
    params: ReadonlyArray<string | number>,
  ): T[] => {
    const db = new sqliteMod.DatabaseSync(target, {
      readOnly: true,
      timeout: NODE_SQLITE_BUSY_TIMEOUT_MS,
    });
    try {
      const stmt = db.prepare(sql);
      const rawRows = stmt.all(...params) as Array<Record<string, unknown>>;
      return rawRows.map((row) => ({ ...row })) as T[];
    } finally {
      db.close();
    }
  };

  return {
    backend: 'node:sqlite',
    async queryAll<T>(
      dbPath: string,
      sql: string,
      params?: ReadonlyArray<string | number>,
    ): Promise<T[]> {
      if (disposed) {
        throw new Error('SqliteClient has been disposed');
      }
      const bound = validateSqlAndParams(sql, params);
      scanAndBindSql(sql, bound, false);
      return await runWithMissingAndImmutableFallback<T>(dbPath, sql, true, async (immutable) => {
        const target = immutable ? toSqliteFileUri(dbPath, true) : dbPath;
        return queryTarget<T>(target, sql, bound);
      });
    },
    dispose(): void {
      disposed = true;
    },
  };
}

function parseJsonRowsStdout(stdoutText: string, stderrText: string, source: string): unknown[] {
  const trimmed = stdoutText.trim();
  if (trimmed.length === 0) {
    if (stderrText.trim().length > 0) {
      throw new Error(stderrText.trim());
    }
    return [];
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Unexpected non-array JSON output from ${source}`);
  }
  return parsed;
}

function createCliSqliteClient(
  binaryPath: string,
  execFileFn: ExecFileLike,
  execOpts: ExecFileOptions,
  allowPreStat: boolean,
): SqliteClient {
  let disposed = false;

  return {
    backend: 'sqlite3-cli',
    async queryAll<T>(
      dbPath: string,
      sql: string,
      params?: ReadonlyArray<string | number>,
    ): Promise<T[]> {
      if (disposed) {
        throw new Error('SqliteClient has been disposed');
      }
      const bound = validateSqlAndParams(sql, params);
      const boundSql = scanAndBindSql(sql, bound, true);

      return await runWithMissingAndImmutableFallback<T>(
        dbPath,
        sql,
        allowPreStat,
        async (immutable) => {
          const target = immutable ? toSqliteFileUri(dbPath, true) : dbPath;
          const res = await execFileFn(
            binaryPath,
            ['-readonly', '-json', target, boundSql],
            execOpts,
          );
          return parseJsonRowsStdout(
            toUtf8Text(res.stdout),
            toUtf8Text(res.stderr),
            'sqlite3-cli',
          ) as T[];
        },
      );
    },
    dispose(): void {
      disposed = true;
    },
  };
}

function revivePythonValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1 && typeof obj.__sqlite_blob_b64__ === 'string') {
    return new Uint8Array(Buffer.from(obj.__sqlite_blob_b64__, 'base64'));
  }
  if (keys.length === 1 && typeof obj.__sqlite_blob_hex__ === 'string') {
    return hexToBytes(obj.__sqlite_blob_hex__);
  }
  return value;
}

function revivePythonRow<T>(row: unknown): T {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return row as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(row as Record<string, unknown>)) {
    out[key] = revivePythonValue(val);
  }
  return out as T;
}

function createPythonSqliteClient(
  binaryPath: string,
  execFileFn: ExecFileLike,
  execOpts: ExecFileOptions,
  allowPreStat: boolean,
): SqliteClient {
  let disposed = false;

  return {
    backend: 'python3',
    async queryAll<T>(
      dbPath: string,
      sql: string,
      params?: ReadonlyArray<string | number>,
    ): Promise<T[]> {
      if (disposed) {
        throw new Error('SqliteClient has been disposed');
      }
      const bound = validateSqlAndParams(sql, params);
      scanAndBindSql(sql, bound, false);
      const paramsJson = JSON.stringify(bound);

      return await runWithMissingAndImmutableFallback<T>(
        dbPath,
        sql,
        allowPreStat,
        async (immutable) => {
          const uri = toSqliteFileUri(dbPath, immutable);
          const res = await execFileFn(
            binaryPath,
            ['-c', PYTHON_QUERY_SCRIPT, uri, sql, paramsJson],
            execOpts,
          );
          const rows = parseJsonRowsStdout(
            toUtf8Text(res.stdout),
            toUtf8Text(res.stderr),
            'python3',
          );
          return rows.map((row) => revivePythonRow<T>(row));
        },
      );
    },
    dispose(): void {
      disposed = true;
    },
  };
}

/**
 * Creates a strictly read-only SQLite client using `node:sqlite` first,
 * falling back asynchronously to `sqlite3 -readonly -json` or Python stdlib `sqlite3`.
 */
export async function createSqliteClient(
  options: CreateSqliteClientOptions = {},
): Promise<SqliteClient> {
  if (!options.forceCliFallback) {
    const sqliteMod = await loadAndProbeNodeSqlite();
    if (sqliteMod) {
      return createNodeSqliteClient(sqliteMod);
    }
  }

  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const candidates = resolveBinaryCandidates(platform, env, homeDir);

  const allowPreStat = options.execFileFn === undefined;
  const execFileFn = options.execFileFn ?? createDefaultExecFile();
  const execOpts: ExecFileOptions = {
    encoding: 'utf8',
    timeout: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    maxBuffer: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
    windowsHide: true,
  };

  const sqlite3Candidates =
    options.sqlite3Path !== undefined ? [options.sqlite3Path] : candidates.sqlite3;
  for (const candidate of sqlite3Candidates) {
    if (candidate && (await probeSqlite3Binary(candidate, execFileFn, execOpts))) {
      return createCliSqliteClient(candidate, execFileFn, execOpts, allowPreStat);
    }
  }

  const pythonCandidates =
    options.pythonCandidates !== undefined ? options.pythonCandidates : candidates.python;
  for (const candidate of pythonCandidates) {
    if (candidate && (await probePythonBinary(candidate, execFileFn, execOpts))) {
      return createPythonSqliteClient(candidate, execFileFn, execOpts, allowPreStat);
    }
  }

  throw new Error(
    'No read-only SQLite backend available (tried node:sqlite, sqlite3 CLI, and python3 sqlite3)',
  );
}
