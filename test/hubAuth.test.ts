import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HubAuthClient } from '../src/rpc/hubAuth.ts';
import type { HubEndpoint } from '../src/rpc/hubDiscovery.ts';

function makeEndpoint(port: number): HubEndpoint {
  return { port, csrfToken: 'csrf', host: '127.0.0.1', source: 'process' };
}

function startHub(responses: Record<string, { statusCode?: number; body: unknown }>): Promise<{
  server: http.Server;
  port: number;
  requests: string[];
}> {
  return new Promise((resolve) => {
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      const method = (req.url ?? '').split('/').pop() ?? '';
      requests.push(method);
      const spec = responses[method] ?? { statusCode: 200, body: {} };
      res.writeHead(spec.statusCode ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(spec.body ?? {}));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as import('node:net').AddressInfo;
      resolve({ server, port: address.port, requests });
    });
  });
}

test('HubAuthClient.login falls back to antigravity.login when Connect Login says hub-only', async () => {
  const { server, port, requests } = await startHub({
    Login: { statusCode: 400, body: { code: 'failed_precondition', message: 'only supported in antigravity-hub mode' } },
  });

  try {
    const client = new HubAuthClient();
    const vscodeApi = {
      commands: {
        executeCommand: async (cmd: string, ...args: unknown[]) => {
          commandsCalled.push(cmd);
          return args.length === 1 ? args[0] : undefined;
        },
      },
    };
    const commandsCalled: string[] = [];
    const endpoint = makeEndpoint(port);
    const result = await client.login(endpoint, vscodeApi as never);

    assert.ok(requests.includes('Login'), 'Login RPC must be attempted first');
    assert.deepEqual(commandsCalled, ['antigravity.login']);
    assert.equal(result, true);
  } finally {
    server.close();
  }
});

test('HubAuthClient.logout calls AuthLogout and reports success', async () => {
  const { server, port, requests } = await startHub({
    AuthLogout: { statusCode: 200, body: { success: true } },
  });

  try {
    const client = new HubAuthClient();
    const result = await client.logout(makeEndpoint(port));
    assert.equal(result, true);
    assert.deepEqual(requests, ['AuthLogout']);
  } finally {
    server.close();
  }
});

test('HubAuthClient.syncOfficialUi tries antigravity.handleAuthRefresh -> reconnect -> triggerUpdate -> connectHub in order until one returns true', async () => {
  const commandsCalled: string[] = [];
  const vscodeApi = {
    commands: {
      executeCommand: async (cmd: string) => {
        commandsCalled.push(cmd);
        if (cmd === 'antigravity.reconnect') {
          return true;
        }
        return undefined;
      },
    },
  };

  const client = new HubAuthClient();
  const result = await client.syncOfficialUi(vscodeApi as never);

  assert.equal(result, true);
  assert.deepEqual(commandsCalled, ['antigravity.handleAuthRefresh', 'antigravity.reconnect']);
});

test('HubAuthClient.getAuthStatus parses authed:false from GetAuthStatus', async () => {
  const { server, port, requests } = await startHub({
    GetAuthStatus: { statusCode: 200, body: { authed: false } },
  });

  try {
    const client = new HubAuthClient();
    const status = await client.getAuthStatus(makeEndpoint(port));
    assert.deepEqual(status, { authed: false });
    assert.ok(requests.includes('GetAuthStatus'));
  } finally {
    server.close();
  }
});

test('HubAuthClient.restartBackendProcess invokes execFileAsync with kill then expects OS restart', async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const execFileAsync = async (file: string, args: string[]) => {
    calls.push({ file, args });
    return { stdout: '', stderr: '' };
  };

  const client = new HubAuthClient();
  const result = await client.restartBackendProcess(4242, execFileAsync);

  assert.equal(result, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'kill');
  assert.deepEqual(calls[0].args, ['4242']);
});
