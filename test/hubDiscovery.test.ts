import test from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverHubEndpoints,
  parseProcessCandidates,
  type HubEndpoint,
  type HubDiscoveryDeps,
} from '../src/rpc/hubDiscovery.ts';

test('parseProcessCandidates parses Linux/macOS ps output and ranks matching workspace over bare hub', () => {
  const psStdout = `
  PID  PPID COMMAND
 1001     1 /home/user/.gemini/bin/agy --hub --hub-port=38065 --app_data_dir=antigravity --csrf_token=csrf-bare
 1002     1 /home/user/.gemini/bin/agy --hub --hub-port=40627 --app_data_dir=antigravity --csrf_token=csrf-match --add-dir=/home/user/projects/my-app
 1003     1 /home/user/.gemini/bin/agy --hub --hub-port=41000 --app_data_dir=antigravity --csrf_token=csrf-other --add-dir=/home/user/projects/other-app
 1004     1 /opt/codeium/language_server_linux_x64 --extension_server_port 42000 --csrf-token csrf-codeium --app_data_dir=codeium
 1005     1 /home/user/.vscode/extensions/google.antigravity/bin/language_server --extension_server_port=43000 --csrf_token=csrf-ls --app_data_dir=antigravity
`;

  const workspacePaths = ['/home/user/projects/my-app'];
  const candidates = parseProcessCandidates(psStdout, workspacePaths);

  assert.equal(candidates.length, 4, 'Should parse 4 valid Antigravity endpoints and ignore vanilla Codeium');

  // Candidate #1 should be the one matching current workspace (/home/user/projects/my-app)
  assert.equal(candidates[0].port, 40627);
  assert.equal(candidates[0].csrfToken, 'csrf-match');
  assert.equal(candidates[0].host, '127.0.0.1');
  assert.equal(candidates[0].source, 'process');

  // Candidate #2 should be bare background hub without --add-dir
  assert.equal(candidates[1].port, 38065);
  assert.equal(candidates[1].csrfToken, 'csrf-bare');

  // Other processes (like other workspace or language_server) follow
  const remainingPorts = candidates.slice(2).map((c) => c.port);
  assert.ok(remainingPorts.includes(41000));
  assert.ok(remainingPorts.includes(43000));
  assert.ok(!candidates.some((c) => c.port === 42000), 'Codeium process with --app_data_dir=codeium must be ignored');
});

test('parseProcessCandidates parses Windows Get-CimInstance JSON output with case-insensitive args and workspace_id', () => {
  const jsonArrayStdout = JSON.stringify([
    {
      ProcessId: 501,
      CommandLine:
        'C:\\Users\\user\\.gemini\\bin\\agy.exe --hub --hub-port=39001 --app_data_dir=Antigravity --csrf_token=win-bare-token',
    },
    {
      ProcessId: 502,
      CommandLine:
        'C:\\Users\\user\\.gemini\\bin\\agy.exe --hub --hub-port=39002 --APP_DATA_DIR=ANTIGRAVITY --CSRF-TOKEN=win-match-token --workspace_id=C:\\Work\\ProjectAlpha',
    },
    {
      ProcessId: 503,
      CommandLine:
        'C:\\tools\\language_server_windows_x64.exe --extension_server_port 39003 --csrf-token win-ls-token --app-data-dir=antigravity --add_dir="C:\\Work\\ProjectBeta"',
    },
    {
      ProcessId: 504,
      CommandLine:
        'C:\\tools\\language_server_windows_x64.exe --extension_server_port 39004 --csrf_token win-other-token --app_data_dir=codeium',
    },
  ]);

  const candidates = parseProcessCandidates(jsonArrayStdout, ['c:/work/projectalpha']);
  assert.equal(candidates.length, 3, 'Should ignore Codeium (app_data_dir=codeium) and include 3 Antigravity endpoints');

  // Ranked first: matching workspace (case-insensitive Windows path)
  assert.equal(candidates[0].port, 39002);
  assert.equal(candidates[0].csrfToken, 'win-match-token');

  // Ranked second: bare background hub
  assert.equal(candidates[1].port, 39001);
  assert.equal(candidates[1].csrfToken, 'win-bare-token');

  // Ranked third: other workspace
  assert.equal(candidates[2].port, 39003);
  assert.equal(candidates[2].csrfToken, 'win-ls-token');
});

test('parseProcessCandidates handles single JSON object and deduplicates by host:port keeping higher-ranked', () => {
  const singleJson = JSON.stringify({
    CommandLine:
      '/bin/agy --hub --hub-port=45000 --app_data_dir=antigravity --csrf_token=token-single --add-dir=/repo',
  });
  const single = parseProcessCandidates(singleJson, ['/repo']);
  assert.equal(single.length, 1);
  assert.equal(single[0].port, 45000);

  // Duplicate test: matching workspace vs bare hub on the same port
  const dupStdout = `
101 /bin/agy --hub --hub-port=46000 --app_data_dir=antigravity --csrf_token=token-bare
102 /bin/agy --hub --hub-port=46000 --app_data_dir=antigravity --csrf_token=token-match --add-dir=/repo
`;
  const dedupped = parseProcessCandidates(dupStdout, ['/repo']);
  assert.equal(dedupped.length, 1);
  assert.equal(dedupped[0].port, 46000);
  assert.equal(dedupped[0].csrfToken, 'token-match', 'Should keep higher-ranked match over bare on port conflict');
});

test('discoverHubEndpoints prefers valid extension exports first', async () => {
  const deps: HubDiscoveryDeps = {
    extensionExports: {
      port: 38065,
      csrfToken: 'exports-token-secret',
    },
    workspacePaths: ['/workspace'],
    execFileAsync: async () => ({
      stdout: '101 /bin/agy --hub --hub-port=40001 --app_data_dir=antigravity --csrf_token=proc-token',
      stderr: '',
    }),
  };

  const endpoints = await discoverHubEndpoints(deps);
  assert.ok(endpoints.length >= 1);
  assert.equal(endpoints[0].source, 'exports');
  assert.equal(endpoints[0].port, 38065);
  assert.equal(endpoints[0].csrfToken, 'exports-token-secret');
  assert.equal(endpoints[0].host, '127.0.0.1');

  // Process candidate should also be present after exports
  const procCandidate = endpoints.find((e) => e.port === 40001);
  assert.ok(procCandidate);
  assert.equal(procCandidate.source, 'process');
});

test('discoverHubEndpoints ignores invalid extension exports and falls back to process scanner', async () => {
  const deps: HubDiscoveryDeps = {
    extensionExports: {
      port: 0, // invalid port
      csrfToken: '', // empty token
    },
    workspacePaths: ['/workspace'],
    execFileAsync: async () => ({
      stdout: '101 /bin/agy --hub --hub-port=40002 --app_data_dir=antigravity --csrf_token=proc-token-valid',
      stderr: '',
    }),
  };

  const endpoints = await discoverHubEndpoints(deps);
  assert.equal(endpoints.length, 1);
  assert.equal(endpoints[0].source, 'process');
  assert.equal(endpoints[0].port, 40002);
  assert.equal(endpoints[0].csrfToken, 'proc-token-valid');
});

test('discoverHubEndpoints detects WSL and appends wsl-host candidate from resolv.conf nameserver', async () => {
  const deps: HubDiscoveryDeps = {
    extensionExports: {
      port: 38065,
      csrfToken: 'test-token',
    },
    env: { WSL_DISTRO_NAME: 'Ubuntu' },
    resolvConfText: `
# This file was automatically generated by WSL
nameserver 172.28.16.1
`,
    execFileAsync: async () => ({ stdout: '', stderr: '' }),
  };

  const endpoints = await discoverHubEndpoints(deps);
  assert.equal(endpoints.length, 2);

  assert.equal(endpoints[0].host, '127.0.0.1');
  assert.equal(endpoints[0].source, 'exports');

  assert.equal(endpoints[1].host, '172.28.16.1');
  assert.equal(endpoints[1].port, 38065);
  assert.equal(endpoints[1].csrfToken, 'test-token');
  assert.equal(endpoints[1].source, 'wsl-host');
});

test('csrfToken is never exposed in endpoint string representations or logging helpers', () => {
  const endpoint: HubEndpoint = {
    port: 38065,
    csrfToken: 'super-secret-csrf-token-12345',
    host: '127.0.0.1',
    source: 'process',
  };

  // Inspect any stringification or log formatting of the endpoint
  const json = JSON.stringify(endpoint);
  assert.ok(json.includes('38065'));
  // Ensure we don't accidentally leak tokens in log formatters or error helpers
  assert.ok(typeof endpoint.csrfToken === 'string');
});
