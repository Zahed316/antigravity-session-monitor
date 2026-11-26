# Live Quota Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Status bar and bottom panel show the hub's current 5h/weekly quota on their own cadence, and the refresh button makes the new numbers visible immediately.

**Architecture:** Split the single refresh loop in two: a light quota-only poll on `quotaRefreshIntervalMs`, and the heavy telemetry loop (SQLite + trajectories + generator metadata) on `refreshIntervalMs`. Quota is fetched from every discovered hub and the freshest bucket wins, so a lagging hub cannot pin a stale number. A manual refresh runs the quota poll first and publishes it before the heavy work.

**Tech Stack:** TypeScript, `node:test` + `node:assert/strict`, VS Code extension API, Connect-RPC over local HTTP.

**Spec:** Bug fix, no design doc. Root-cause evidence lives in "Investigation Notes" at the end.

## Global Constraints

- Read-only toward Antigravity. Never write under `~/.gemini/antigravity/`.
- No new dependencies.
- Keep `MonitorServiceDeps` injectable (`timerFactory`, `now`, mock `hubClient`, mock `discoverEndpoints`). All tests go through it.
- `npm run check` and `npm test` pass after every task.
- Settings keep existing semantics: `quotaRefreshIntervalMs` minimum `5000`; `quotaUnfocusedMultiplier` in `0..12`; `0` pauses quota polling while unfocused.
- Test runner command is `npm test` (`node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON --test test/*.test.ts`). Single file: `node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON --test test/monitorService.test.ts`.

## Review Focus

1. Hub returns HTTP 200 with `remainingFraction: 0` and `resetTime` in the past. UI must keep `0%`, not clamp to `100%`. (Task 3.)
2. Two hubs disagree and the one with the later `resetTime` has the lower fraction. Freshest-wins must take the later `resetTime`. (Task 2.)
3. `quotaUnfocusedMultiplier = 0`. No quota poll while unfocused, resumes on focus. (Task 1.)
4. Refresh clicked while a heavy refresh is already in flight. Quota is still re-fetched and published before the in-flight run ends. (Task 4.)
5. All hubs unreachable. Panel shows the last good numbers marked stale instead of dropping to the offline placeholder. (Task 5.)

---

### Task 1: Quota poll on its own cadence

**Files:**
- Modify: `src/monitorService.ts` — `start()` (line ~187), `resetPollingTimer()` (line ~312), `dispose()` (line ~636), `performRefresh()` quota block (lines 360–393)
- Test: `test/monitorService.test.ts`

**Interfaces:**
- Consumes: `MonitorConfig.quotaRefreshIntervalMs`, `MonitorConfig.quotaUnfocusedMultiplier` (both already on the type and `DEFAULT_CONFIG`).
- Produces:
  - `public async refreshQuotaNow(): Promise<void>` on `MonitorService`. Updates `state.quota`, `state.hubStatus`, `state.hubPort`, `state.hubSource`, `state.lastUpdatedAt`, then calls `onDidUpdateState`. Never touches `localReader`, trajectories or generator metadata.
  - `private quotaTimer: any`, `private resetQuotaPollingTimer(): void`.
  - `private lastGoodQuota: QuotaSnapshot | null` (Task 5 reads it).

- [ ] **Step 1: Write the failing test**

Append inside `describe('MonitorService Orchestrator', ...)` in `test/monitorService.test.ts`:

```ts
it('4. Quota polls on its own cadence (focused, multiplied unfocused, paused at multiplier 0)', async () => {
  // Cadence values are all distinct so the active timer can be identified by its
  // interval, not by registration order (updateConfig re-registers only quota).
  const active = new Map<number, { ms: number | undefined; fn: () => void }>();
  let nextId = 1;

  const fakeTimers = {
    setTimeout: (fn: any, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: any) => clearTimeout(id),
    setInterval: (fn: any, ms?: number) => {
      const id = nextId++;
      active.set(id, { ms, fn });
      return id as any;
    },
    clearInterval: (id: any) => {
      active.delete(id);
    },
  };

  const quotaIntervals = () => [...active.values()].filter((t) => t.ms === 30_000 || t.ms === 60_000);
  const telemetryIntervals = () => [...active.values()].filter((t) => t.ms === 10_000 || t.ms === 20_000);

  let quotaCalls = 0;
  const mockHubClient: any = {
    fetchQuota: async () => {
      quotaCalls++;
      return createMockQuota('online');
    },
    fetchTrajectories: async () => new Map(),
    fetchGeneratorMetadata: async () => [],
  };
  const mockLocalReader: any = {
    read: async () => ({ summaries: [], callsById: new Map(), lastConversationId: null }),
    flushCache: async () => {},
    clearMemoryCache: () => {},
  };

  const makeConfig = (multiplier: number): MonitorConfig => ({
    ...DEFAULT_CONFIG,
    refreshIntervalMs: 10_000,
    unfocusedRefreshIntervalMs: 20_000,
    quotaRefreshIntervalMs: 30_000,
    quotaUnfocusedMultiplier: multiplier,
  });

  const service = new MonitorService({
    localReader: mockLocalReader,
    hubClient: mockHubClient,
    discoverEndpoints: async () => [{ port: 1, csrfToken: 't', host: '127.0.0.1', source: 'process' }],
    workspacePaths: ['/w'],
    config: makeConfig(2),
    timerFactory: fakeTimers,
    watchFactory: () => ({ close() {} }),
  });

  await service.start();
  assert.strictEqual(telemetryIntervals().length, 1, 'telemetry timer registered');
  assert.strictEqual(telemetryIntervals()[0].ms, 10_000);
  assert.strictEqual(quotaIntervals().length, 1, 'quota timer registered');
  assert.strictEqual(quotaIntervals()[0].ms, 30_000, 'focused quota cadence is quotaRefreshIntervalMs');

  service.setWindowFocused(false);
  assert.deepStrictEqual(telemetryIntervals().map((t) => t.ms), [20_000]);
  assert.deepStrictEqual(quotaIntervals().map((t) => t.ms), [60_000], 'unfocused quota is interval * multiplier');

  service.updateConfig(makeConfig(0));
  assert.strictEqual(quotaIntervals().length, 0, 'multiplier 0 registers no quota timer while unfocused');
  const pausedCalls = quotaCalls;
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(quotaCalls, pausedCalls, 'no quota fetch while paused despite a stale timer reference');

  service.setWindowFocused(true);
  assert.deepStrictEqual(quotaIntervals().map((t) => t.ms), [30_000], 'quota polling resumes when focused');

  service.dispose();
  service.dispose();
});
```

Add `MonitorConfig` to the existing `import type { ... } from '../src/types.ts'` if it is not already imported.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON --test test/monitorService.test.ts 2>&1 | grep -A8 "Quota polls on its own cadence"`
Expected: FAIL at `assert.strictEqual(quotaIntervals().length, 1)` — `0 !== 1`, only one timer exists today.

Note: `displayedQuota`/`paused` assertions rely on `setWindowFocused` being a no-op when the state is unchanged; it already early-returns in that case.

- [ ] **Step 3: Implement in `src/monitorService.ts`**

Add the members and methods from Interfaces. Body rules:

- `start()`: after `this.resetPollingTimer()`, call `this.resetQuotaPollingTimer()`. Order matters for the test (telemetry first).
- `resetQuotaPollingTimer()`: clear `this.quotaTimer` if set. Return if `!this.started || this.disposed`. Compute
  `const intervalMs = this.isWindowFocused ? this.config.quotaRefreshIntervalMs : this.config.quotaRefreshIntervalMs * this.config.quotaUnfocusedMultiplier;`
  If `!this.isWindowFocused && this.config.quotaUnfocusedMultiplier === 0`, return without registering. Else register `setInterval(() => void this.refreshQuotaNow(), intervalMs)`.
- `setWindowFocused()` and `updateConfig()`: also call `this.resetQuotaPollingTimer()`.
- `dispose()`: clear `this.quotaTimer`.
- `refreshQuotaNow()`: reuse the endpoint list discovered by the last `performRefresh` (store it in `private discoveredEndpoints: HubEndpoint[] = []`), or call `this.discoverEndpoints({ workspacePaths: this.workspacePaths })` when it is empty. For every endpoint call `this.hubClient.fetchQuota(ep, this.now())` inside try/catch. Feed all results to `selectFreshQuota` (Task 2). Until Task 2 lands, take the first `online` result. Assign to `this.state.quota` only when `status === 'online'`; also set `hubStatus: 'connected'`, `hubPort`, `hubSource`, `lastUpdatedAt: this.now()`. Call `this.onDidUpdateState?.(this.state)` once at the end.
- In `performRefresh()`: remove the quota fetch loop (lines ~371–380). Set `quotaSnapshot` from `this.state.quota` if it is `online`, else from `buildOfflineQuota(now)`. `activeEndpoint` for the telemetry RPCs keeps using the quota-selected endpoint when one exists, else `endpoints[0]`. Store `this.discoveredEndpoints = endpoints`.

- [ ] **Step 4: Run tests**

Run: `npm run check && npm test`
Expected: pass, 91 tests.

- [ ] **Step 5: Commit**

```bash
git add src/monitorService.ts test/monitorService.test.ts
git commit -m "fix(quota): poll quota on its own configurable cadence"
```

---

### Task 2: Freshest hub wins

**Files:**
- Create: `src/core/quotaFreshness.ts`
- Modify: `src/monitorService.ts` (`refreshQuotaNow` from Task 1)
- Test: `test/quotaFreshness.test.ts`

**Interfaces:**
- Produces: `export function selectFreshQuota(snapshots: QuotaSnapshot[]): QuotaSnapshot` and `export function snapshotFreshnessMs(snapshot: QuotaSnapshot): number` in `src/core/quotaFreshness.ts`.

```ts
export function snapshotFreshnessMs(snapshot: QuotaSnapshot): number;
// Latest resetTime across every non-null window in snapshot.pools, as epoch ms.
// Negative infinity when the snapshot has no windows.

export function selectFreshQuota(snapshots: QuotaSnapshot[]): QuotaSnapshot;
// Among snapshots with status 'online', return the one with the highest
// snapshotFreshnessMs; ties broken by the later fetchedAt. If none are online,
// return the first snapshot, or an all-offline snapshot when the array is empty.
```

- [ ] **Step 1: Write the failing test**

Create `test/quotaFreshness.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFreshQuota, snapshotFreshnessMs } from '../src/core/quotaFreshness.ts';
import type { QuotaSnapshot, QuotaWindow } from '../src/types.ts';

function win(fraction: number, resetTime: string | null): QuotaWindow {
  const pct = Math.round(fraction * 100);
  return {
    window: '5h',
    remainingPct: pct,
    remainingFraction: fraction,
    resetTime,
    isReady: fraction > 0,
    isExhausted: fraction === 0,
  };
}

function snap(status: QuotaSnapshot['status'], gemini5h: QuotaWindow, fetchedAt = 0): QuotaSnapshot {
  return {
    status,
    source: status === 'online' ? 'summary' : 'none',
    pools: {
      gemini: { key: 'gemini', displayName: 'Gemini Models', fiveHour: gemini5h, weekly: null },
      nonGoogle: { key: 'nonGoogle', displayName: 'Claude & GPT', fiveHour: null, weekly: null },
    },
    fetchedAt,
  };
}

test('snapshotFreshnessMs returns the latest resetTime across windows, -Infinity with none', () => {
  const s = snap('online', win(0.5, '2026-11-26T17:45:44Z'));
  s.pools.nonGoogle.weekly = win(0.2, '2026-12-03T09:15:42Z');
  assert.strictEqual(snapshotFreshnessMs(s), Date.parse('2026-12-03T09:15:42Z'));

  const empty = snap('online', null as any);
  empty.pools.gemini.fiveHour = null;
  assert.strictEqual(snapshotFreshnessMs(empty), Number.NEGATIVE_INFINITY);
});

test('selectFreshQuota prefers later resetTime over higher fraction', () => {
  // Live shape at 15:49Z: hub A lagging with an old exhausted window, hub B current.
  const lagging = snap('online', win(0, '2026-11-26T14:15:42Z'), 1000);
  const current = snap('online', win(0.436, '2026-11-26T19:25:51Z'), 1000);
  assert.strictEqual(selectFreshQuota([lagging, current]), current);
  assert.strictEqual(selectFreshQuota([current, lagging]), current, 'order independent');
});

test('selectFreshQuota ignores offline snapshots and falls back to the first when none are online', () => {
  const offline = snap('offline', null as any, 5000);
  offline.pools.gemini.fiveHour = null;
  const online = snap('online', win(0.1, '2026-11-26T19:25:51Z'), 1);
  assert.strictEqual(selectFreshQuota([offline, online]), online);
  assert.strictEqual(selectFreshQuota([offline]), offline);
});

test('selectFreshQuota breaks resetTime ties by later fetchedAt', () => {
  const older = snap('online', win(0.9, '2026-11-26T19:25:51Z'), 1);
  const newer = snap('online', win(0.3, '2026-11-26T19:25:51Z'), 2);
  assert.strictEqual(selectFreshQuota([older, newer]), newer);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON --test test/quotaFreshness.test.ts`
Expected: FAIL — `Cannot find module '.../src/core/quotaFreshness.ts'`.

- [ ] **Step 3: Implement `src/core/quotaFreshness.ts`**

Signatures from Interfaces. Implementation notes: iterate `Object.values(snapshot.pools)`, take `fiveHour` and `weekly`, parse `resetTime` with `Date.parse`, skip null or `NaN`. Use `Math.max`.

- [ ] **Step 4: Wire into `refreshQuotaNow` in `src/monitorService.ts`**

Replace the first-online loop with: collect every `fetchQuota` result, then `const selected = selectFreshQuota(results)`. Record which endpoint produced it (iterate endpoints in the same order as results and keep the index) and use that as `state.hubPort` / `state.hubSource`.

- [ ] **Step 5: Run tests**

Run: `npm run check && npm test`
Expected: pass, 95 tests.

- [ ] **Step 6: Commit**

```bash
git add src/core/quotaFreshness.ts test/quotaFreshness.test.ts src/monitorService.ts
git commit -m "fix(quota): pick the freshest hub snapshot, not the first online one"
```

---

### Task 3: Stop clamping a real `0%` to `100%`

**Files:**
- Modify: `src/rpc/hubClient.ts:84-94` (`evaluateQuotaValues`), `src/ui/statusBar.ts:69-85` (`formatResetCountdown`)
- Test: `test/hubClient.test.ts` (test at line 211 must keep passing), `test/ui.test.ts`

**Interfaces:** none new. Behavior change only.

- [ ] **Step 1: Write the failing test**

Append to `test/hubClient.test.ts`:

```ts
test('a reported 0% keeps 0% even when resetTime has passed', () => {
  // Hub says exhausted and its resetTime already passed. Proto3 zero is ambiguous,
  // so an explicit remainingFraction: 0 plus a resetTime is a real exhausted bucket.
  const nowMs = Date.parse('2026-11-26T15:49:00Z');
  const snap = normalizeQuotaFromSummary(
    {
      response: {
        groups: [
          {
            displayName: 'Claude and GPT models',
            buckets: [
              { bucketId: '3p-5h', window: '5h', remainingFraction: 0, resetTime: '2026-11-26T14:15:42Z' },
              { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.5, resetTime: '2026-12-03T09:15:42Z' },
            ],
          },
        ],
      },
    },
    nowMs,
  );
  assert.strictEqual(snap.pools.nonGoogle.fiveHour?.remainingFraction, 0);
  assert.strictEqual(snap.pools.nonGoogle.fiveHour?.isExhausted, true);
  assert.strictEqual(snap.pools.nonGoogle.fiveHour?.isReady, false);
});
```

Then edit the existing fixture in `Review Focus #4: normalizeQuotaFromSummary handles 0% proto3 zero, unlimited {}, and clamped resetTime` (same file, ~line 249). The `claude-weekly` bucket currently has `remainingFraction: 0.0` with a past `resetTime` and asserts `100`. Remove the `remainingFraction: 0.0,` line from that bucket so it reads as "fraction omitted, reset passed"; leave its assertions at `100` / `1.0`. That keeps the test's stated purpose (proto3 zero and clamp) intact.

Append to `test/ui.test.ts` (adjust the import list to include `formatResetCountdown` if missing):

```ts
test('formatResetCountdown reports Exhausted for 0% with a passed resetTime, Ready only when quota is actually back', () => {
  assert.strictEqual(formatResetCountdown('2026-11-26T14:15:42Z', false, true), 'Exhausted');
  assert.strictEqual(formatResetCountdown(null, false, true), 'Exhausted');
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm test 2>&1 | grep -B2 -A10 "keeps 0%\|reports Exhausted"`
Expected: both FAIL — current code returns `fraction 1.0, isReady true` and the countdown returns `'Ready'` because `diffMs <= 0`.

- [ ] **Step 3: Implement**

`src/rpc/hubClient.ts`, `evaluateQuotaValues`: change the clamp so it only fires when the hub did not report a fraction. New rule, replacing lines 84–94:

```ts
// resetTime passed with no reported fraction: the window rolled over, treat as full.
// An explicit remainingFraction (including 0) is authoritative; do not overwrite it.
if (!hasRemaining && resetTimeStr !== null) {
  const resetMs = Date.parse(resetTimeStr);
  if (!Number.isNaN(resetMs) && resetMs <= nowMs) {
    fraction = 1.0;
  }
}
```

Then set `isReady = fraction > 0`, `isExhausted = fraction === 0` after that block (remove the earlier assignments).

`src/ui/statusBar.ts`, `formatResetCountdown`: move the `if (diffMs <= 0) return 'Ready';` line below the exhausted check. Final order: `isReady` → `'Ready'`; `isExhausted` → `'Exhausted'`; no `resetTime` → `'Active'`; `diffMs <= 0` → `'Ready'`; else the formatted countdown.

- [ ] **Step 4: Run the existing clamp test and the full suite**

Run: `npm test`
Expected: pass, 97 tests. `Review Focus #4` still passes because its `claude-weekly` bucket no longer carries `remainingFraction`.

Do not weaken the new tests to satisfy the old fixture.

- [ ] **Step 5: Commit**

```bash
git add src/rpc/hubClient.ts src/ui/statusBar.ts test/hubClient.test.ts test/ui.test.ts
git commit -m "fix(quota): trust an explicit 0% instead of clamping it to 100%"
```

---

### Task 4: Refresh button publishes quota first

**Files:**
- Modify: `src/monitorService.ts` (`refreshNow`, `performRefresh`)
- Test: `test/monitorService.test.ts`

**Interfaces:**
- Produces: `refreshNow(forceRescan = false)` runs `await this.refreshQuotaNow()` before starting or queuing `performRefresh`. When a heavy refresh is already in flight, the quota poll still runs immediately instead of being coalesced behind it.

- [ ] **Step 1: Write the failing test**

Append inside `describe('MonitorService Orchestrator')`. Reuse the shape of test 3 (blocking `read`, `releaseRead`):

```ts
it('5. refreshNow publishes quota before the heavy telemetry read finishes', async () => {
  let releaseRead: (() => void) | null = null;
  let quotaValue = 0.8;
  const published: number[] = [];

  const mockLocalReader: any = {
    read: async () => {
      await new Promise<void>((res) => {
        releaseRead = res;
      });
      return { summaries: [], callsById: new Map(), lastConversationId: null };
    },
    flushCache: async () => {},
    clearMemoryCache: () => {},
  };

  const mockHubClient: any = {
    fetchQuota: async () => {
      const q = createMockQuota('online');
      q.pools.gemini.fiveHour!.remainingFraction = quotaValue;
      q.pools.gemini.fiveHour!.remainingPct = Math.round(quotaValue * 100);
      return q;
    },
    fetchTrajectories: async () => new Map(),
    fetchGeneratorMetadata: async () => [],
  };

  const service = new MonitorService({
    localReader: mockLocalReader,
    hubClient: mockHubClient,
    discoverEndpoints: async () => [{ port: 1, csrfToken: 't', host: '127.0.0.1', source: 'process' }],
    workspacePaths: ['/w'],
    timerFactory: { setTimeout: (fn: any, ms?: number) => setTimeout(fn, ms), clearTimeout: (id: any) => clearTimeout(id), setInterval: () => 1, clearInterval: () => {} },
    watchFactory: () => ({ close() {} }),
    onDidUpdateState: (state) => published.push(state.quota.pools.gemini.fiveHour?.remainingFraction ?? -1),
  });

  // Let the start() refresh finish: it blocks in read(), so release it.
  void service.start();
  await new Promise((r) => setTimeout(r, 10));
  releaseRead!();
  await new Promise((r) => setTimeout(r, 10));

  // Now hold the heavy path open and ask for a manual refresh.
  const heavy = service.refreshNow();
  await new Promise((r) => setTimeout(r, 10));

  quotaValue = 0.4;
  const manual = service.refreshNow(true);
  await new Promise((r) => setTimeout(r, 10));

  // Quota must already be on screen although read() is still blocked.
  assert.ok(published.includes(0.4), 'quota published while heavy refresh is blocked');
  assert.strictEqual(service.getState().quota.pools.gemini.fiveHour?.remainingFraction, 0.4);

  releaseRead!();
  await heavy;
  await manual;
  service.dispose();
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON --test test/monitorService.test.ts 2>&1 | grep -A8 "publishes quota before"`
Expected: FAIL — `quota published while heavy refresh is blocked` is false; the second `refreshNow` only sets `pendingRefresh`.

- [ ] **Step 3: Implement in `src/monitorService.ts`**

In `refreshNow`, before the `if (this.inFlight)` block: `await this.refreshQuotaNow();`. Keep the rest unchanged. The quota poll has no shared mutex with `performRefresh`, so it completes while `read()` is blocked.

- [ ] **Step 4: Run tests**

Run: `npm run check && npm test`
Expected: pass, 98 tests. Test 3 ("InFlight coalescing") may count `readCallCount`; it must stay at the same numbers since `refreshQuotaNow` never calls `read`.

- [ ] **Step 5: Commit**

```bash
git add src/monitorService.ts test/monitorService.test.ts
git commit -m "fix(refresh): publish fresh quota before the heavy telemetry pass"
```

---

### Task 5: Show staleness instead of hiding numbers

**Files:**
- Modify: `src/types.ts` (`QuotaSnapshot`), `src/monitorService.ts`, `src/ui/statusBar.ts` (`buildCompactQuotaPart`), `src/ui/bottomPanelHtml.ts:649-660`
- Test: `test/ui.test.ts`, `test/monitorService.test.ts`

**Interfaces:**
- Produces: `QuotaSnapshot.isStale?: boolean`. Set by `MonitorService` when the latest poll did not return `online` and the previous snapshot is reused.

- [ ] **Step 1: Write the failing tests**

Append to `test/monitorService.test.ts`:

```ts
it('6. an unreachable hub keeps the last good quota flagged stale', async () => {
  let online = true;
  const mockHubClient: any = {
    fetchQuota: async () => createMockQuota(online ? 'online' : 'offline'),
    fetchTrajectories: async () => new Map(),
    fetchGeneratorMetadata: async () => [],
  };
  const service = new MonitorService({
    localReader: { read: async () => ({ summaries: [], callsById: new Map(), lastConversationId: null }), flushCache: async () => {}, clearMemoryCache: () => {} } as any,
    hubClient: mockHubClient,
    discoverEndpoints: async () => [{ port: 1, csrfToken: 't', host: '127.0.0.1', source: 'process' }],
    workspacePaths: ['/w'],
    timerFactory: { setTimeout: (fn: any, ms?: number) => setTimeout(fn, ms), clearTimeout: (id: any) => clearTimeout(id), setInterval: () => 1, clearInterval: () => {} },
    watchFactory: () => ({ close() {} }),
  });
  await service.start();
  assert.strictEqual(service.getState().quota.pools.gemini.fiveHour?.remainingPct, 85);

  online = false;
  await service.refreshQuotaNow();
  const q = service.getState().quota;
  assert.strictEqual(q.status, 'online', 'last good snapshot is kept');
  assert.strictEqual(q.isStale, true);
  assert.strictEqual(q.pools.gemini.fiveHour?.remainingPct, 85, 'numbers are not zeroed');
  service.dispose();
});
```

Append to `test/ui.test.ts`:

```ts
test('status bar marks quota stale with a clock glyph and keeps the numbers', () => {
  const state = createState({ quota: createQuota({ isStale: true }) });
  const fresh = createState({ quota: createQuota() });
  const vm = buildStatusBarViewModel(state, DEFAULT_CONFIG);
  const expected = buildStatusBarViewModel(fresh, DEFAULT_CONFIG).text.replace(' · G ', ' · $(clock) G ');
  assert.strictEqual(vm.text, expected);
  assert.match(vm.text, /\$\(clock\) G 85% · C 90%$/);
  assert.match(vm.tooltipMarkdown, /stale/i);
});
```

`createState` (line 163) and `createQuota` (line 113) already exist in `test/ui.test.ts`; `createQuota()` defaults to `online` with `G 85%` / `C 90%`. The quota part is always the last ` · G … · C …` segment of the status text.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm test 2>&1 | grep -B2 -A10 "flagged stale\|marks quota stale"`
Expected: FAIL — `isStale` is `undefined`; tooltip has no "stale".

- [ ] **Step 3: Implement**

`src/types.ts`: add `isStale?: boolean;` to `QuotaSnapshot`.

`src/monitorService.ts`, `refreshQuotaNow`: after `selectFreshQuota`, if `selected.status !== 'online'` and `this.lastGoodQuota` exists, set `this.state.quota = { ...this.lastGoodQuota, isStale: true }`. If online, set `this.lastGoodQuota = selected` and `this.state.quota = selected`. Set `lastGoodQuota` initially to `null`.

`src/ui/statusBar.ts`, `buildCompactQuotaPart`: when `state.quota.isStale`, return text `` `$(clock) ${segments.join(' · ')}` `` and keep the color the percentages already produce. In `buildStatusBarViewModel`, prepend one line to the quota table in the tooltip when stale: `` `> Quota data is stale — last fetched ${new Date(state.quota.fetchedAt).toLocaleTimeString()}` ``.

`src/ui/bottomPanelHtml.ts` ~line 650: change `const quotaOnline = quota.status === 'online';` to also accept `quota.isStale`, and when stale render a one-line note above the grid: `<div class="section-hint">Stale — last fetched HH:MM</div>` using the same `toLocaleTimeString` call.

- [ ] **Step 4: Run tests**

Run: `npm run check && npm test`
Expected: pass, 100 tests.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/monitorService.ts src/ui/statusBar.ts src/ui/bottomPanelHtml.ts test/ui.test.ts test/monitorService.test.ts
git commit -m "fix(quota): keep last good numbers and flag them stale when the hub is unreachable"
```

---

### Task 6: Verify against the real hub, bump, package

**Files:**
- Modify: `CHANGELOG.md`, `package.json` (`version`), `README.md` (badge, install line, status line)

- [ ] **Step 1: Build and install**

Run: `npm run check && npm test && npm run build && npm run package`
Then: `code --install-extension antigravity-session-monitor-0.1.5.vsix --force`

- [ ] **Step 2: Manual check**

Reload the VS Code window. In the bottom panel press the refresh button twice, ten seconds apart. Run in a terminal:

```sh
tok=$(ps -A -ww -o args | grep -- '--hub-port=45019' | grep -v grep | sed -E 's/.*--csrf_token=([^ ]+).*/\1/' | head -1)
curl -s -X POST "http://127.0.0.1:45019/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary" \
  -H 'Content-Type: application/json' -H 'Connect-Protocol-Version: 1' -H "x-codeium-csrf-token: $tok" \
  -d '{"metadata":{"ideName":"antigravity","extensionName":"antigravity","locale":"en"}}' \
  | python3 -c "import json,sys; [print(b['bucketId'], round(b['remainingFraction']*100,1)) for g in json.load(sys.stdin)['response']['groups'] for b in g['buckets']]"
```

Expected: status bar `G x% · C y%` matches the curl output within one refresh, and changes within one second of pressing refresh.

- [ ] **Step 3: Version and changelog**

Set `version` to `0.1.5` in `package.json`. Replace `0.1.4` with `0.1.5` in `README.md` (badge, install command, status line). Add to `CHANGELOG.md` above `## [0.1.4]`:

```markdown
## [0.1.5] - 2026-11-26

### Fixed

- Quota now polls on `quotaRefreshIntervalMs` (x `quotaUnfocusedMultiplier` when unfocused, paused at `0`). Previously the setting was read but never used and quota only refreshed with the telemetry loop.
- With several Antigravity hubs running, the snapshot with the latest `resetTime` wins instead of the first hub in process order.
- An explicit `remainingFraction: 0` is no longer clamped to 100% when its `resetTime` has passed.
- The refresh button re-fetches and shows quota before the heavier session telemetry pass completes.
- When the hub is unreachable, the last good quota stays visible and is marked stale.
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md README.md package.json
git commit -m "chore(release): 0.1.5"
```

---

## Investigation Notes

Live evidence, 2026-11-26 15:49Z, two `agy --hub` processes on ports 45019 and 42643:

| time | port | gemini-5h | gemini-wk | 3p-5h | 3p-wk |
|---|---|---|---|---|---|
| 15:33Z | 45019 | 0.4% | 48.8% | 0% | 50% |
| 15:33Z | 42643 | 1.3% | 49.7% | 43.6% | 21.8% |
| 15:49Z | both | 1.31% | 49.74% | 43.65% | 21.82% |

- Port 45019 served a snapshot 16 minutes old at 15:33Z. Same account. First-online endpoint selection took it.
- `GetUserStatus` fallback carries `Claude 0.492098 @2026-12-02` while the summary endpoint reports `3p-5h 43.65% @19:25Z`. The fallback is stale; Task 2's freshness rank pushes it below a current summary.
- `quotaRefreshIntervalMs` and `quotaUnfocusedMultiplier`: declared in `package.json`, documented in `README.md`, read in `getConfiguration()`, never consumed. `resetPollingTimer()` only reads `refreshIntervalMs`. Introduced in `bffe1ef`, never wired.
- `refreshNow(true)` calls `localReader.read(forceRescan=true)`, a full SQLite sweep of every conversation DB. Quota is fetched after that read inside `performRefresh`. A refresh click waits for the sweep before quota moves.
- `evaluateQuotaValues` sets `fraction = 1.0` when `resetTime <= now`, discarding an explicit `remainingFraction: 0`. `formatResetCountdown` returns `'Ready'` for the same case.
