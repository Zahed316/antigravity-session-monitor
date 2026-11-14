import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  HubClient,
  normalizeQuotaFromSummary,
  normalizeQuotaFromUserStatus,
} from '../src/rpc/hubClient.ts';
import type { HubEndpoint } from '../src/rpc/hubDiscovery.ts';
import { DEFAULT_CONTEXT_LIMIT } from '../src/types.ts';

// Helper to generate a temporary self-signed certificate for testing HTTPS fallback
function generateSelfSignedCert(): { key: string; cert: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-test-cert-'));
  const keyPath = path.join(tmpDir, 'key.pem');
  const certPath = path.join(tmpDir, 'cert.pem');
  try {
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
    ]);
    const key = fs.readFileSync(keyPath, 'utf8');
    const cert = fs.readFileSync(certPath, 'utf8');
    return { key, cert };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('HubClient calls Connect-RPC with required headers, auto-falls back to HTTPS, and caches protocol', async () => {
  const { key, cert } = generateSelfSignedCert();
  let receivedHeaders: http.IncomingHttpHeaders | null = null;
  let requestCount = 0;

  const httpsServer = https.createServer({ key, cert }, (req, res) => {
    requestCount++;
    receivedHeaders = req.headers;
    if (req.url === '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          groups: [
            {
              displayName: 'Gemini',
              buckets: [
                {
                  bucketId: 'gemini-5h',
                  window: '5h',
                  remainingFraction: 0.8,
                  resetTime: '2026-11-14T10:00:00Z',
                },
              ],
            },
          ],
        }),
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => httpsServer.listen(0, '127.0.0.1', resolve));
  const address = httpsServer.address() as { port: number };
  const endpoint: HubEndpoint = {
    host: '127.0.0.1',
    port: address.port,
    csrfToken: 'test-csrf-token-xyz',
    source: 'process',
  };

  try {
    const client = new HubClient();

    // First call: initial HTTP attempt fails/resets on HTTPS port, falls back to HTTPS and succeeds
    const quota = await client.fetchQuota(endpoint);
    assert.equal(quota.status, 'online');
    assert.equal(quota.source, 'summary');
    assert.equal(quota.pools.gemini.fiveHour?.remainingPct, 80);

    // Verify Connect-RPC wire headers
    assert.ok(receivedHeaders);
    assert.equal(receivedHeaders['connect-protocol-version'], '1');
    assert.equal(receivedHeaders['x-codeium-csrf-token'], 'test-csrf-token-xyz');
    assert.equal(receivedHeaders['content-type'], 'application/json');

    // Protocol should now be cached as 'https:'
    assert.equal(client.getCachedProtocol(endpoint), 'https:');

    const prevCount = requestCount;
    // Second call: should hit HTTPS directly without HTTP probe attempt
    await client.fetchQuota(endpoint);
    assert.equal(requestCount, prevCount + 1);
  } finally {
    await new Promise((resolve) => httpsServer.close(resolve));
  }
});

test('Review Focus #1: fetchTrajectories handles empty {} vs populated candidate and offline ECONNREFUSED', async () => {
  // Candidate #1: HTTP server returning empty trajectorySummaries ({})
  const serverEmpty = http.createServer((req, res) => {
    if (req.url === '/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ trajectorySummaries: {} }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  // Candidate #2: HTTP server returning populated trajectories
  const serverPopulated = http.createServer((req, res) => {
    if (req.url === '/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          trajectorySummaries: {
            'cascade-1': {
              stepCount: 12,
              status: 'CASCADE_RUN_STATUS_RUNNING',
              trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE',
              workspaces: [{ workspaceFolderAbsoluteUri: 'file:///home/user/project' }],
            },
          },
        }),
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await Promise.all([
    new Promise<void>((r) => serverEmpty.listen(0, '127.0.0.1', r)),
    new Promise<void>((r) => serverPopulated.listen(0, '127.0.0.1', r)),
  ]);

  const portEmpty = (serverEmpty.address() as { port: number }).port;
  const portPopulated = (serverPopulated.address() as { port: number }).port;

  const endpointEmpty: HubEndpoint = {
    host: '127.0.0.1',
    port: portEmpty,
    csrfToken: 'token1',
    source: 'process',
  };
  const endpointPopulated: HubEndpoint = {
    host: '127.0.0.1',
    port: portPopulated,
    csrfToken: 'token2',
    source: 'process',
  };
  // Candidate #3: offline closed port
  const endpointOffline: HubEndpoint = {
    host: '127.0.0.1',
    port: 59999,
    csrfToken: 'token3',
    source: 'process',
  };

  try {
    const client = new HubClient();

    // Test offline endpoint: returns null / offline status without throwing!
    const offlineTrajectories = await client.fetchTrajectories(endpointOffline);
    assert.equal(offlineTrajectories, null, 'Offline endpoint must return null without throwing');

    const offlineQuota = await client.fetchQuota(endpointOffline);
    assert.equal(offlineQuota.status, 'offline');
    assert.equal(offlineQuota.source, 'none');

    const offlineMeta = await client.fetchGeneratorMetadata(endpointOffline, 'c1', 5);
    assert.equal(offlineMeta, null);

    // Single empty endpoint returns empty Map
    const emptyMap = await client.fetchTrajectories(endpointEmpty);
    assert.ok(emptyMap instanceof Map);
    assert.equal(emptyMap.size, 0);

    // Fallthrough across candidates: candidate #1 has {}, candidate #2 has trajectories
    const merged = await client.fetchTrajectories([endpointEmpty, endpointPopulated]);
    assert.ok(merged instanceof Map);
    assert.equal(merged.size, 1);
    assert.ok(merged.has('cascade-1'));
    assert.equal(merged.get('cascade-1')?.stepCount, 12);
  } finally {
    await Promise.all([
      new Promise((r) => serverEmpty.close(r)),
      new Promise((r) => serverPopulated.close(r)),
    ]);
  }
});

test('Review Focus #4: normalizeQuotaFromSummary handles 0% proto3 zero, unlimited {}, and clamped resetTime', () => {
  const nowMs = Date.parse('2026-11-14T03:30:00Z');

  const rawSummary = {
    groups: [
      {
        displayName: 'Google Gemini',
        buckets: [
          {
            bucketId: 'gemini-5h',
            window: '5h',
            remainingFraction: 0.65,
            resetTime: '2026-11-14T08:00:00Z',
          },
          {
            bucketId: 'gemini-weekly',
            window: 'weekly',
            remainingFraction: 0.9,
            resetTime: '2026-11-20T00:00:00Z',
          },
          {
            // Gemini 4 Carbon / unlimited bucket with no remainingFraction and no resetTime
            bucketId: 'gemini-carbon-unlimited',
            window: '5h',
          },
        ],
      },
      {
        displayName: 'Claude / Anthropic',
        buckets: [
          {
            bucketId: 'claude-5h',
            window: '5h',
            // resetTime present + remainingFraction omitted -> 0% exhausted!
            resetTime: '2026-11-14T07:00:00Z',
          },
          {
            bucketId: 'claude-weekly',
            window: 'weekly',
            remainingFraction: 0.0,
            // resetTime is in the past! (resetTime <= nowMs) -> clamped to 100% Ready!
            resetTime: '2026-11-14T02:00:00Z',
          },
        ],
      },
    ],
  };

  const snapshot = normalizeQuotaFromSummary(rawSummary, nowMs);
  assert.equal(snapshot.status, 'online');
  assert.equal(snapshot.source, 'summary');

  // Gemini pool
  const gemini = snapshot.pools.gemini;
  assert.equal(gemini.key, 'gemini');
  assert.equal(gemini.fiveHour?.remainingPct, 65);
  assert.equal(gemini.fiveHour?.isReady, true);
  assert.equal(gemini.fiveHour?.isExhausted, false);
  assert.equal(gemini.weekly?.remainingPct, 90);

  // NonGoogle pool
  const nonGoogle = snapshot.pools.nonGoogle;
  assert.equal(nonGoogle.key, 'nonGoogle');
  // 5h window: resetTime present but remainingFraction omitted -> 0% exhausted
  assert.equal(nonGoogle.fiveHour?.remainingPct, 0);
  assert.equal(nonGoogle.fiveHour?.remainingFraction, 0);
  assert.equal(nonGoogle.fiveHour?.isExhausted, true);
  assert.equal(nonGoogle.fiveHour?.isReady, false);

  // weekly window: resetTime <= nowMs -> clamped to 100% Ready
  assert.equal(nonGoogle.weekly?.remainingPct, 100);
  assert.equal(nonGoogle.weekly?.remainingFraction, 1.0);
  assert.equal(nonGoogle.weekly?.isReady, true);
  assert.equal(nonGoogle.weekly?.isExhausted, false);
});

test('Review Focus #4: normalizeQuotaFromUserStatus fallback ignores unlimited {} and takes pool minimum', () => {
  const nowMs = Date.parse('2026-11-14T03:30:00Z');

  const rawUserStatus = {
    userStatus: {
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: 'Gemini 2.5 Pro',
            modelOrAlias: { model: 'gemini-2.5-pro' },
            quotaInfo: {
              remainingFraction: 0.42,
              resetTime: '2026-11-14T08:00:00Z',
            },
          },
          {
            label: 'Gemini 2.5 Flash',
            modelOrAlias: { model: 'gemini-2.5-flash' },
            quotaInfo: {
              remainingFraction: 0.88,
              resetTime: '2026-11-14T08:00:00Z',
            },
          },
          {
            // Gemini 4 Carbon: {} -> ignored as unlimited (does not drag pool down to 0%)
            label: 'Gemini 4 Carbon',
            modelOrAlias: { model: 'gemini-4-carbon' },
            quotaInfo: {},
          },
          {
            label: 'Claude 3.7 Sonnet',
            modelOrAlias: { model: 'claude-3-7-sonnet' },
            quotaInfo: {
              // resetTime present + remainingFraction omitted -> 0% exhausted
              resetTime: '2026-11-14T06:00:00Z',
            },
          },
        ],
      },
    },
  };

  const snapshot = normalizeQuotaFromUserStatus(rawUserStatus, nowMs);
  assert.equal(snapshot.status, 'online');
  assert.equal(snapshot.source, 'userStatus');

  // Gemini pool should take the minimum (0.42 / 42%), ignoring Gemini 4 Carbon's {}
  assert.equal(snapshot.pools.gemini.fiveHour?.remainingPct, 42);
  assert.equal(snapshot.pools.gemini.fiveHour?.remainingFraction, 0.42);

  // NonGoogle pool (Claude 3.7) has resetTime but no remainingFraction -> 0%
  assert.equal(snapshot.pools.nonGoogle.fiveHour?.remainingPct, 0);
  assert.equal(snapshot.pools.nonGoogle.fiveHour?.isExhausted, true);
});

test('fetchGeneratorMetadata caches by (cascadeId, stepCount) and maps CallUsagePoints correctly', async () => {
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata') {
      requestCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          generatorMetadata: [
            {
              stepIndices: [1, 2],
              chatModel: {
                model: 'gemini-2.5-pro',
                usage: {
                  inputTokens: 1000,
                  cacheReadTokens: 4000,
                  outputTokens: 500,
                  thinkingOutputTokens: 200,
                  responseOutputTokens: 300,
                  apiProvider: 'google',
                },
                chatStartMetadata: {
                  startStepIndex: 0,
                  contextWindowMetadata: {
                    estimatedTokensUsed: 5200, // > fresh (1000) + cacheRead (4000) = 5000 -> effectiveContext = 5200
                    maxContextTokens: 1000000,
                    tokenBreakdown: [
                      { name: 'System Instructions', tokens: 500 },
                      { name: 'Chat History', tokens: 4700 },
                    ],
                  },
                },
              },
            },
            {
              stepIndices: [3],
              chatModel: {
                model: 'gemini-2.5-pro',
                usage: {
                  inputTokens: 800,
                  cacheReadTokens: 1200,
                  outputTokens: 400,
                  thinkingOutputTokens: 150,
                  responseOutputTokens: 250,
                },
                chatStartMetadata: {
                  startStepIndex: 12, // Compacted transition from step 0 to 12!
                  contextWindowMetadata: {
                    estimatedTokensUsed: 1900, // < fresh (800) + cacheRead (1200) = 2000 -> effectiveContext = 2000
                    // maxContextTokens omitted -> must use DEFAULT_CONTEXT_LIMIT (256_000, never 255_000)
                  },
                },
              },
            },
          ],
        }),
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const endpoint: HubEndpoint = {
    host: '127.0.0.1',
    port,
    csrfToken: 'test-token',
    source: 'process',
  };

  try {
    const client = new HubClient();

    // Call 1: should make 1 HTTP request
    const calls1 = await client.fetchGeneratorMetadata(endpoint, 'cascade-xyz', 10);
    assert.equal(requestCount, 1);
    assert.ok(Array.isArray(calls1));
    assert.equal(calls1.length, 2);

    // Call point 0 verification
    const c0 = calls1[0];
    assert.equal(c0.idx, 0);
    assert.deepEqual(c0.stepIndices, [1, 2]);
    assert.equal(c0.model, 'gemini-2.5-pro');
    assert.equal(c0.fresh, 1000);
    assert.equal(c0.cacheRead, 4000);
    assert.equal(c0.output, 500);
    assert.equal(c0.thinking, 200);
    assert.equal(c0.response, 300);
    assert.equal(c0.effectiveContext, 5200); // Math.max(5200, 1000 + 4000)
    assert.equal(c0.contextLimit, 1000000);
    assert.equal(c0.isCompacted, false);
    assert.equal(c0.tokenBreakdownGroups?.length, 2);

    // Call point 1 verification
    const c1 = calls1[1];
    assert.equal(c1.idx, 1);
    assert.equal(c1.effectiveContext, 2000); // Math.max(1900, 800 + 1200) = 2000
    assert.equal(c1.contextLimit, DEFAULT_CONTEXT_LIMIT, 'Must default to 256_000, never 255_000');
    assert.equal(c1.isCompacted, true, 'Transition from startStepIndex 0 to 12 must mark isCompacted');
    assert.equal(c1.compactedFromStep, 12);

    // Call 2: same cascadeId and stepCount -> ZERO duplicate HTTP calls (requestCount unchanged)
    const calls2 = await client.fetchGeneratorMetadata(endpoint, 'cascade-xyz', 10);
    assert.equal(requestCount, 1, 'Unchanged stepCount must make 0 duplicate HTTP calls');
    assert.equal(calls2, calls1, 'Should return memoized instance');

    // Call 3: stepCount changed -> makes new HTTP request
    await client.fetchGeneratorMetadata(endpoint, 'cascade-xyz', 11);
    assert.equal(requestCount, 2);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
