# ADR 0001 — Rank hub snapshots by earliest reset time

## Status

Accepted.

## Context

Several Antigravity hubs can run at once on different ports, and they disagree. On 2026-11-26 at 18:19Z two hubs served these numbers for the same account:

| port | gemini 5h | gemini weekly | nonGoogle 5h | nonGoogle weekly |
|---|---|---|---|---|
| 45019 | 1.31% | 49.74% | 43.65% | 21.82% |
| 42643 | 100% | 49.74% | 43.65% | 21.82% |

The extension has to pick one snapshot to display. The obvious rule — trust the hub whose window resets latest, since that is the newer window — picked the wrong one here. Both hubs reported the *identical* weekly reset time (the weekly window is long and stable, so it is shared), so the rule tied, fell through to fetch-order, and displayed the first hub: 1.31% when the truth was 100%.

## Decision

Rank snapshots by the **earliest** reset time across their windows, not the latest.

The bucket that rolled most recently is the one that resets soonest. A five-hour window that has already reset is a lagging hub's stale copy; the hub that has rolled that window forward has a reset time further in the future for that window but is serving current data. Comparing every window and taking the earliest makes the lagging hub lose on its own stale bucket, and it cannot be masked by a long shared window that both hubs report identically.

Ties (identical reset times on every window, or no windows at all) fall through to the later fetch time, then to endpoint order. An empty snapshot ranks below every real one.

## Consequences

- The rule is not "newest wins" in the naive sense; anyone reading `snapshotFreshnessMs` expecting a maximum will be surprised. This ADR is the reason.
- It assumes at least one window rolls at a time, which holds for both windows of both pools.
- It does not detect a hub that is stale in exactly the same way as another hub; those agree, so either choice is harmless.
- Ranking is independent of parse success: a snapshot whose windows do not parse ranks as empty, so a broken hub never wins by accident.
