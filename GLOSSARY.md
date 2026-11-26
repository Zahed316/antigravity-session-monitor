# Glossary

Terms as this project uses them. No implementation detail — that belongs in code and ADRs.

## Session

A conversation with an AI model, as recorded by Antigravity. The root of a tree of work. Sessions are what the Sessions list shows and what you select to inspect.

## Subagent

An agent spawned by a session to do work in the background: research, tests, edits. In the data it has the same shape as a session, but it is owned by the session that spawned it. Not a kind of session — a different role. The UI calls an individual one a *subagent*; a user asking about "agents" may mean subagents, models from the forecast, or both.

## Unattached subagent

A subagent whose spawning session cannot be determined, usually because the parent record is gone or predates the current data layout. It still has its own usage and status, so it is listed separately rather than discarded or invented into a parent.

## Quota pool

One of two independent allowances Antigravity tracks: `gemini` (Gemini and Argon models) and `nonGoogle` (Claude and GPT). Each pool holds two windows, a rolling five-hour one and a weekly one. Pools do not lend to each other.

## Quota window

One allowance span inside a quota pool, either five-hour or weekly. A window is identified by its reset time: when usage falls and the reset time moves forward, the window has rolled, and the remaining fraction climbs back.

## Snapshot

One reading of quota from one place at one moment. A snapshot is *fresh* when its windows have rolled recently, *stale* when it is a previous good reading kept because the current fetch failed, and *offline* when no reading succeeded.

## Hub

The local Antigravity process that answers quota questions over HTTP. Several can run at once, on different ports, and they do not necessarily agree — an older one may keep answering with an outdated snapshot.

## Preview list

A capped list that shows its first few entries plus a toggle for the rest. The cap is a display concern only: the full data is always loaded, the section title keeps the true total, and a pinned or active entry is never hidden by the cap.
