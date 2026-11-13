import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createSqliteClient,
  resolveBinaryCandidates,
  type ExecFileLike,
} from '../src/data/sqliteClient.ts';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-sqlite-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function createSampleWalDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE gen_metadata (
      idx INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      data BLOB
    );
  `);
  const insert = db.prepare('INSERT INTO gen_metadata (idx, name, data) VALUES (?, ?, ?)');
  insert.run(0, 'alpha', Uint8Array.from([0x0a, 0x02, 0x10, 0x01]));
  insert.run(1, "O'Reilly ? test", Uint8Array.from([0x0a, 0x04, 0xff, 0x00, 0x80, 0x7f]));
  insert.run(2, 'gamma', new Uint8Array(0));
  return db;
}

test('node:sqlite reads WAL-mode rows, BLOBs, and bound params strictly read-only', async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, 'wal-session.db');
    const writer = createSampleWalDb(dbPath);

    const client = await createSqliteClient();
    try {
      assert.equal(client.backend, 'node:sqlite');

      // Append row 3 on open WAL writer without closing writer (WAL file stays active).
      writer
        .prepare('INSERT INTO gen_metadata (idx, name, data) VALUES (?, ?, ?)')
        .run(3, "delta'; DROP TABLE gen_metadata; --", Uint8Array.from([0x12, 0x34]));

      const allRows = await client.queryAll<{ idx: number; name: string; data: Uint8Array }>(
        dbPath,
        'SELECT idx, name, data FROM gen_metadata ORDER BY idx ASC',
      );
      assert.equal(allRows.length, 4);
      assert.equal(allRows[0].idx, 0);
      assert.ok(allRows[0].data instanceof Uint8Array);
      assert.deepEqual(allRows[0].data, Uint8Array.from([0x0a, 0x02, 0x10, 0x01]));
      assert.deepEqual(allRows[1].data, Uint8Array.from([0x0a, 0x04, 0xff, 0x00, 0x80, 0x7f]));
      assert.deepEqual(allRows[2].data, new Uint8Array(0));

      // Parameterized WHERE idx > ? query (Task 4 incremental contract).
      const incremental = await client.queryAll<{ idx: number; name: string; data: Uint8Array }>(
        dbPath,
        'SELECT idx, name, data FROM gen_metadata WHERE idx > ? ORDER BY idx ASC',
        [1],
      );
      assert.deepEqual(
        incremental.map((r) => r.idx),
        [2, 3],
      );

      // Parameterized string query with single quotes, SQL injection payload, and literal '?'.
      const byName = await client.queryAll<{ idx: number; name: string }>(
        dbPath,
        "SELECT idx, name FROM gen_metadata WHERE name = ? AND '?' = '?' AND idx >= ?",
        ["O'Reilly ? test", 1],
      );
      assert.deepEqual(byName, [{ idx: 1, name: "O'Reilly ? test" }]);

      const injectionSafe = await client.queryAll<{ idx: number }>(
        dbPath,
        'SELECT idx FROM gen_metadata WHERE name = ?',
        ["delta'; DROP TABLE gen_metadata; --"],
      );
      assert.deepEqual(injectionSafe, [{ idx: 3 }]);

      // Strictly read-only: INSERT must fail.
      await assert.rejects(
        () =>
          client.queryAll(dbPath, 'INSERT INTO gen_metadata (idx, name, data) VALUES (?, ?, ?)', [
            99,
            'mutated',
            'abc',
          ]),
        /readonly/i,
      );

      // Consistent parameter validation on node:sqlite.
      await assert.rejects(
        () => client.queryAll(dbPath, 'SELECT idx FROM gen_metadata WHERE idx > ?'),
        /mismatch/i,
      );
      await assert.rejects(
        () => client.queryAll(dbPath, 'SELECT idx FROM gen_metadata WHERE idx > ?', [Number.NaN]),
        /finite/i,
      );
    } finally {
      client.dispose();
      client.dispose(); // Idempotent dispose.
      writer.close();
    }
  });
});

test('node:sqlite falls back to immutable read-only URI when directory is read-only', async () => {
  if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
    return;
  }

  await withTempDir(async (dir) => {
    const roDir = path.join(dir, 'readonly-mount');
    await fs.mkdir(roDir);
    const dbPath = path.join(roDir, 'locked.db');
    const writer = createSampleWalDb(dbPath);
    writer.close();

    await fs.chmod(dbPath, 0o444);
    await fs.chmod(roDir, 0o555);

    const client = await createSqliteClient();
    try {
      const rows = await client.queryAll<{ idx: number; name: string }>(
        dbPath,
        'SELECT idx, name FROM gen_metadata WHERE idx > ? ORDER BY idx ASC',
        [1],
      );
      assert.deepEqual(rows, [
        { idx: 2, name: 'gamma' },
      ]);

      await assert.rejects(
        () => client.queryAll(dbPath, 'INSERT INTO gen_metadata (idx, name) VALUES (?, ?)', [9, 'x']),
        /readonly/i,
      );
    } finally {
      client.dispose();
      await fs.chmod(roDir, 0o755);
      await fs.chmod(dbPath, 0o644);
    }
  });
});

test('resolveBinaryCandidates includes Android SDK, Homebrew, and Windows .exe paths', () => {
  const linux = resolveBinaryCandidates(
    'linux',
    { ANDROID_HOME: '/opt/android-sdk' },
    '/home/dev',
  );
  assert.ok(linux.sqlite3.includes('sqlite3'));
  assert.ok(linux.sqlite3.includes('/opt/android-sdk/platform-tools/sqlite3'));
  assert.ok(linux.sqlite3.includes('/home/dev/Android/Sdk/platform-tools/sqlite3'));
  assert.ok(linux.sqlite3.includes('/home/linuxbrew/.linuxbrew/bin/sqlite3'));
  assert.ok(linux.python.includes('python3'));
  assert.ok(linux.python.includes('/home/linuxbrew/.linuxbrew/bin/python3'));

  const mac = resolveBinaryCandidates(
    'darwin',
    { ANDROID_SDK_ROOT: '/Users/dev/Library/Android/sdk' },
    '/Users/dev',
  );
  assert.ok(mac.sqlite3.includes('/opt/homebrew/bin/sqlite3'));
  assert.ok(mac.sqlite3.includes('/opt/homebrew/opt/sqlite/bin/sqlite3'));
  assert.ok(mac.sqlite3.includes('/usr/local/bin/sqlite3'));
  assert.ok(mac.sqlite3.includes('/Users/dev/Android/Sdk/platform-tools/sqlite3'));
  assert.ok(mac.sqlite3.includes('/Users/dev/Library/Android/sdk/platform-tools/sqlite3'));
  assert.ok(mac.python.includes('/opt/homebrew/bin/python3'));

  const win = resolveBinaryCandidates(
    'win32',
    {
      LOCALAPPDATA: 'C:\\Users\\Dev\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
    },
    'C:\\Users\\Dev',
  );
  assert.ok(win.sqlite3.includes('sqlite3.exe'));
  assert.ok(win.sqlite3.includes('C:\\Users\\Dev\\Android\\Sdk\\platform-tools\\sqlite3.exe'));
  assert.ok(
    win.sqlite3.includes('C:\\Users\\Dev\\AppData\\Local\\Android\\Sdk\\platform-tools\\sqlite3.exe'),
  );
  assert.ok(win.python.includes('python3.exe'));
  assert.ok(win.python.includes('python.exe'));
  assert.ok(
    win.python.includes('C:\\Users\\Dev\\AppData\\Local\\Programs\\Python\\Python313\\python.exe'),
  );
});

test('sqlite3-cli fallback uses -readonly -json and safely binds params outside SQL quotes', async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];

  const mockExec: ExecFileLike = async (file, args) => {
    calls.push({ file, args });
    if (file === '/custom/bin/sqlite3' && args[0] === '--version') {
      return { stdout: '3.46.1 2024-08-13 abcdef', stderr: '' };
    }
    if (file === '/custom/bin/sqlite3' && args[0] === '-readonly' && args[1] === '-json') {
      const sql = args[3];
      if (sql.includes('idx <= 99')) {
        return { stdout: '', stderr: '' };
      }
      return {
        stdout: JSON.stringify([
          { idx: 3, name: "O'Reilly", data_hex: '0A02FF' },
        ]),
        stderr: '',
      };
    }
    throw Object.assign(new Error(`ENOENT ${file}`), { code: 'ENOENT' });
  };

  const client = await createSqliteClient({
    forceCliFallback: true,
    sqlite3Path: '/custom/bin/sqlite3',
    execFileFn: mockExec,
  });

  try {
    assert.equal(client.backend, 'sqlite3-cli');

    const rows = await client.queryAll<{ idx: number; name: string; data_hex: string }>(
      '/tmp/mock.db',
      "SELECT idx, name, hex(data) AS data_hex FROM gen_metadata WHERE idx > ? AND name = ? AND '?' = '?' -- ?\n/* ? */",
      [2, "O'Reilly"],
    );
    assert.deepEqual(rows, [{ idx: 3, name: "O'Reilly", data_hex: '0A02FF' }]);

    const queryCall = calls.find((c) => c.args[0] === '-readonly');
    assert.ok(queryCall);
    assert.equal(queryCall.args[1], '-json');
    assert.equal(queryCall.args[2], '/tmp/mock.db');
    assert.equal(
      queryCall.args[3],
      "SELECT idx, name, hex(data) AS data_hex FROM gen_metadata WHERE idx > 2 AND name = 'O''Reilly' AND '?' = '?' -- ?\n/* ? */",
    );

    const emptyRows = await client.queryAll<{ idx: number }>(
      '/tmp/mock.db',
      'SELECT "col?a", `col?b`, [col?c] FROM gen_metadata WHERE idx >= ? AND idx <= ?',
      [-0, 99],
    );
    assert.deepEqual(emptyRows, []);
    const zeroCall = calls.at(-1);
    assert.ok(zeroCall);
    assert.equal(
      zeroCall.args[3],
      'SELECT "col?a", `col?b`, [col?c] FROM gen_metadata WHERE idx >= 0 AND idx <= 99',
    );

    // Reject unsafe or mismatched bindings.
    await assert.rejects(
      () => client.queryAll('/tmp/mock.db', '.shell whoami'),
      /dot-commands/i,
    );
    await assert.rejects(
      () => client.queryAll('/tmp/mock.db', 'SELECT idx FROM gen_metadata WHERE idx > ?', [Number.NaN]),
      /finite/i,
    );
    await assert.rejects(
      () => client.queryAll('/tmp/mock.db', 'SELECT idx FROM gen_metadata WHERE idx > ?', [Infinity]),
      /finite/i,
    );
    await assert.rejects(
      () => client.queryAll('/tmp/mock.db', 'SELECT idx FROM gen_metadata WHERE name = ?', ['bad\0str']),
      /NUL/i,
    );
    await assert.rejects(
      () => client.queryAll('/tmp/mock.db', 'SELECT idx FROM gen_metadata WHERE idx > ?'),
      /mismatch/i,
    );
    await assert.rejects(
      () => client.queryAll('/tmp/mock.db', 'SELECT idx FROM gen_metadata', [1]),
      /mismatch/i,
    );
    await assert.rejects(
      () => client.queryAll('/tmp/mock.db', 'SELECT idx FROM gen_metadata WHERE idx > ?1', [1]),
      /numbered/i,
    );
    await assert.rejects(
      () => client.queryAll('/tmp/mock.db', "SELECT 'unterminated", [1]),
      /unterminated/i,
    );
  } finally {
    client.dispose();
  }
});

test('python3 fallback skips missing sqlite3 and Windows Store WindowsApps stubs, and binds params cleanly', async () => {
  const probed: string[] = [];
  const executed: Array<{ file: string; args: readonly string[] }> = [];

  const mockExec: ExecFileLike = async (file, args) => {
    if (args[0] === '--version') {
      probed.push(file);
      if (file.includes('WindowsApps')) {
        if (file.endsWith('python3.exe')) {
          // Simulated exit 9009 with Microsoft Store stderr.
          throw Object.assign(new Error('Command failed with exit code 9009'), {
            code: 9009,
            stdout: '',
            stderr:
              'Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings.',
          });
        }
        // Simulated zero-byte stub returning exit 0 with empty stdout.
        return { stdout: '', stderr: '' };
      }
      if (file.endsWith('stub-store-stderr.exe')) {
        return { stdout: 'Python was not found; Microsoft Store', stderr: 'Microsoft Store' };
      }
      if (file === 'C:\\Python312\\python.exe') {
        return { stdout: 'Python 3.12.7\r\n', stderr: '' };
      }
      throw Object.assign(new Error(`ENOENT ${file}`), { code: 'ENOENT' });
    }

    executed.push({ file, args });
    const uriArg = args[2];
    const sqlArg = args[3];
    const paramsArg = args[4];
    assert.ok(uriArg.includes('?mode=ro'));
    assert.equal(sqlArg, 'SELECT idx, name, data FROM gen_metadata WHERE idx > ? AND name = ?');
    assert.deepEqual(JSON.parse(paramsArg), [2, "a'b; DROP TABLE x;--"]);

    return {
      stdout: JSON.stringify([
        {
          idx: 3,
          name: "a'b; DROP TABLE x;--",
          data: { __sqlite_blob_b64__: Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString('base64') },
        },
      ]),
      stderr: '',
    };
  };

  const client = await createSqliteClient({
    forceCliFallback: true,
    sqlite3Path: '/missing/sqlite3',
    pythonCandidates: [
      'C:\\Users\\Dev\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe',
      'C:\\Users\\Dev\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe',
      'C:\\stub-store-stderr.exe',
      'C:\\Python312\\python.exe',
    ],
    execFileFn: mockExec,
  });

  try {
    assert.equal(client.backend, 'python3');
    assert.deepEqual(probed, [
      '/missing/sqlite3',
      'C:\\Users\\Dev\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe',
      'C:\\Users\\Dev\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe',
      'C:\\stub-store-stderr.exe',
      'C:\\Python312\\python.exe',
    ]);

    const rows = await client.queryAll<{ idx: number; name: string; data: Uint8Array }>(
      '/tmp/session.db',
      'SELECT idx, name, data FROM gen_metadata WHERE idx > ? AND name = ?',
      [2, "a'b; DROP TABLE x;--"],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].idx, 3);
    assert.equal(rows[0].name, "a'b; DROP TABLE x;--");
    assert.ok(rows[0].data instanceof Uint8Array);
    assert.equal(Buffer.isBuffer(rows[0].data), false);
    assert.deepEqual(rows[0].data, Uint8Array.from([0xde, 0xad, 0xbe, 0xef]));
    assert.equal(executed.length, 1);

    await assert.rejects(
      () => client.queryAll('/tmp/session.db', 'SELECT idx FROM gen_metadata WHERE idx > ?'),
      /mismatch/i,
    );
    await assert.rejects(
      () => client.queryAll('/tmp/session.db', 'SELECT idx FROM gen_metadata WHERE idx > ?', [Number.NaN]),
      /finite/i,
    );
  } finally {
    client.dispose();
  }
});

test('missing DB file (ENOENT) returns [] cleanly across backends without throwing', async () => {
  await withTempDir(async (dir) => {
    const missingDb = path.join(dir, 'does-not-exist.db');

    const nodeClient = await createSqliteClient();
    try {
      const rows = await nodeClient.queryAll(missingDb, 'SELECT idx FROM gen_metadata WHERE idx > ?', [0]);
      assert.deepEqual(rows, []);
    } finally {
      nodeClient.dispose();
    }

    const cliMockClient = await createSqliteClient({
      forceCliFallback: true,
      sqlite3Path: 'sqlite3',
      execFileFn: async (_file, args) => {
        if (args[0] === '--version') {
          return { stdout: '3.45.0 2024-01-01', stderr: '' };
        }
        throw Object.assign(new Error('Error: unable to open database file'), {
          code: 1,
          stderr: 'Error: unable to open database "/missing": unable to open database file',
        });
      },
    });
    try {
      const rows = await cliMockClient.queryAll(missingDb, 'SELECT 1');
      assert.deepEqual(rows, []);
    } finally {
      cliMockClient.dispose();
    }
  });
});

test('real sqlite3 CLI and python3 integration smoke against WAL DB when available on PATH/candidates', async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, 'integration-wal.db');
    const writer = createSampleWalDb(dbPath);

    try {
      let cliClient = null;
      try {
        cliClient = await createSqliteClient({
          forceCliFallback: true,
          pythonCandidates: [],
        });
      } catch {
        cliClient = null;
      }

      if (cliClient) {
        assert.equal(cliClient.backend, 'sqlite3-cli');
        try {
          const rows = await cliClient.queryAll<{ idx: number; name: string; data_hex: string }>(
            dbPath,
            'SELECT idx, name, hex(data) AS data_hex FROM gen_metadata WHERE idx > ? AND name = ? ORDER BY idx ASC',
            [0, "O'Reilly ? test"],
          );
          assert.equal(rows.length, 1);
          assert.equal(rows[0].idx, 1);
          assert.equal(rows[0].name, "O'Reilly ? test");
          assert.equal(rows[0].data_hex, '0A04FF00807F');
          await assert.rejects(
            () => cliClient.queryAll(dbPath, 'INSERT INTO gen_metadata (idx, name) VALUES (?, ?)', [8, 'x']),
            /readonly/i,
          );
        } finally {
          cliClient.dispose();
        }
      }

      let pyClient = null;
      try {
        pyClient = await createSqliteClient({
          forceCliFallback: true,
          sqlite3Path: '/definitely-missing-sqlite3-binary-for-test',
        });
      } catch {
        pyClient = null;
      }

      if (pyClient) {
        assert.equal(pyClient.backend, 'python3');
        try {
          const rows = await pyClient.queryAll<{ idx: number; name: string; data: Uint8Array }>(
            dbPath,
            'SELECT idx, name, data FROM gen_metadata WHERE idx > ? ORDER BY idx ASC',
            [0],
          );
          assert.equal(rows.length, 2);
          assert.equal(rows[0].idx, 1);
          assert.equal(rows[0].name, "O'Reilly ? test");
          assert.ok(rows[0].data instanceof Uint8Array);
          assert.deepEqual(rows[0].data, Uint8Array.from([0x0a, 0x04, 0xff, 0x00, 0x80, 0x7f]));
          assert.deepEqual(rows[1].data, new Uint8Array(0));
          await assert.rejects(
            () => pyClient.queryAll(dbPath, 'INSERT INTO gen_metadata (idx, name) VALUES (?, ?)', [8, 'x']),
            /readonly/i,
          );
        } finally {
          pyClient.dispose();
        }
      }
    } finally {
      writer.close();
    }
  });
});

test('fallback rejects ancient sqlite3 (<3.33), handles immutable fallback on existing DB, rejects use after dispose, and errors when no backend exists', async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, 'ro-fallback.db');
    await fs.writeFile(dbPath, 'placeholder');

    const pyTargets: string[] = [];
    const pyClient = await createSqliteClient({
      forceCliFallback: true,
      sqlite3Path: '/old/sqlite3',
      pythonCandidates: ['/opt/python3'],
      execFileFn: async (file, args) => {
        if (file === '/old/sqlite3' && args[0] === '--version') {
          return { stdout: '3.28.0 2019-04-16', stderr: '' };
        }
        if (file === '/opt/python3' && args[0] === '--version') {
          return { stdout: 'Python 3.11.9', stderr: '' };
        }
        if (file === '/opt/python3' && args[0] === '-c') {
          const uri = args[2];
          pyTargets.push(uri);
          if (!uri.includes('immutable=1')) {
            throw Object.assign(new Error('attempt to write a readonly database'), {
              code: 1,
              stderr: 'sqlite3.OperationalError: attempt to write a readonly database',
            });
          }
          return { stdout: JSON.stringify([{ ok: 1 }]), stderr: '' };
        }
        throw Object.assign(new Error(`Unexpected ${file}`), { code: 'ENOENT' });
      },
    });

    assert.equal(pyClient.backend, 'python3');
    const rows = await pyClient.queryAll<{ ok: number }>(dbPath, 'SELECT 1 AS ok');
    assert.deepEqual(rows, [{ ok: 1 }]);
    assert.equal(pyTargets.length, 2);
    assert.match(pyTargets[0], /\?mode=ro$/);
    assert.match(pyTargets[1], /\?mode=ro&immutable=1$/);

    // Write statement must NOT trigger immutable fallback.
    await assert.rejects(
      () => pyClient.queryAll(dbPath, '/* c */ INSERT INTO t VALUES (?)', [1]),
      /readonly/i,
    );
    assert.equal(pyTargets.length, 3);

    pyClient.dispose();
    await assert.rejects(() => pyClient.queryAll(dbPath, 'SELECT 1'), /disposed/i);
  });

  await assert.rejects(
    () =>
      createSqliteClient({
        forceCliFallback: true,
        sqlite3Path: '/missing/sqlite3',
        pythonCandidates: ['/missing/python3'],
        execFileFn: async () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
      }),
    /No read-only SQLite backend available/i,
  );
});

