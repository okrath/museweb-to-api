---
title: "One primary Muse thread, disposable side threads for subagents"
description: "Route the main agent into one fixed side thread, give subagents clean warm threads, delete idle and retired threads, reload slow tabs."
status: in-progress
priority: P2
effort: 2d
branch: main
tags: [router, muse-driver, threads]
blockedBy: []
blocks: []
created: 2026-10-11
---

# One primary Muse thread, disposable side threads for subagents

Decision record: `plans/reports/brainstorm-261011-1732-primary-thread-and-side-pool.md` (local,
git-ignored). Its `/clear` design was abandoned after a live spike showed `/clear` keeps a side
thread's context; this plan implements the replacement, "decision A": clean pre-created threads
plus deleting used ones. Contract fields below supersede the report's older ones.

## Outcome

- The main agent's turns all land in one side thread (the **primary**). When its history no
  longer matches (a new client conversation), the gateway moves it to a clean warm thread, sends
  the full transcript, and retires the old primary thread.
- Each subagent gets its own clean warm thread; its follow-ups continue there via the existing
  session fingerprint. No thread that has content is ever handed to a different conversation.
- A side thread whose last turn ended more than **5 minutes** ago is deleted from Muse together
  with its session rows. At most **10** side threads exist; on overflow the least-recently-used
  idle side thread is retired.
- A tab whose page reads have become slow is reloaded before its next turn.

## Classification (measured on omp 18.8.7, 2026-10-11)

Only the tool set tells the agents apart: same headers, same system prompt, no session id. The
main agent always carries the delegation tool (`task`), subagents never do.

- Request whose tools include a name from `PRIMARY_TOOL_NAMES` (default `task,Task,Agent`) →
  primary.
- Anything else, including tool-less requests → side. omp/Claude Code title and summary requests
  carry no tools and would otherwise rotate (and delete) the primary mid-session.

## Constraints

- Never delete a thread while a turn runs on it (rotation, idle reaping, cap eviction alike).
- Only threads the gateway registered are ever deleted; user-made threads and the main chat `/`
  are never touched. This replaces `enforceThreadCap`, which deleted the oldest panel rows
  regardless of owner.
- Background work (warm refill, reaping) takes a slot with `acquire(0)` and never blocks a
  client request. With `MAX_CONCURRENT_TURNS=2` the primary plus one subagent fill the browser:
  a second parallel subagent queues and warm refill pauses during bursts. Raising the slot count
  is the user's lever, not this plan's.
- No tab is reserved for the primary; `idlePageAt` parking already keeps its tab on its URL.
- AGENTS.md rules hold: selectors only in `selectors.ts`, pure logic unit-tested without
  Playwright, files under ~300 lines (`page-driver.ts` is already 689, so new driver code goes in
  `thread-cleanup.ts` / `browser.ts`), no Muse usage-limit workarounds.

## Non-goals

- Using the main chat `/`.
- Reusing a thread that has content (`/clear` does not reset context).
- Detecting subagents for clients other than omp and Claude Code beyond the configurable name list.
- Changing slot counts or the warm-pool size default.

## Acceptance criteria

1. Consecutive main-agent turns, including across a gateway restart, use the same
   `conversationId`; the panel does not grow.
2. A new main-agent conversation moves to a clean thread; the previous primary disappears from
   the Muse panel (verified after reload) within one reaper cycle once it is not in use.
3. Two parallel subagents get two different threads; neither ever sees the other's or the
   primary's context.
4. A side thread idle for over 5 minutes is gone from Muse and `sessions.json`; its subagent's
   follow-up (if any) falls back to a fresh thread with the full transcript.
5. Gateway-registered side threads never exceed 10; user-made threads are untouched.
6. A tab over the slow-read threshold is reloaded before its next turn, logged with the measured
   time.
7. `pnpm lint`, `pnpm test`, build green; README, `docs/architecture.md`, `docs/muse-driver.md`
   updated; a live omp run with a subagent reproduces 1–4.

## Prerequisites (block implementation, not this plan)

- The 12 uncommitted files (the `clean-threads` feature and thread-cleanup edits) touch nearly
  every module below. Commit them first as their own feature commit (decision 2), after
  restoring the `build` script that the uncommitted `package.json` dropped and running
  lint, test and build.

## Phases

| # | Phase | Status | Depends on |
|---|---|---|---|
| 1 | [Thread registry and classification](phase-01-thread-registry.md) | done | — |
| 2 | [Delete a thread by URL](phase-02-delete-thread-by-url.md) | done | — |
| 3 | [Route primary and side requests](phase-03-route-primary-and-side.md) | done | 1, 2 |
| 4 | [Thread reaper](phase-04-thread-reaper.md) | done | 1, 2, 3 |
| 5 | [Reload slow tabs](phase-05-reload-slow-tabs.md) | done | — |
| 6 | [Docs and live verification](phase-06-docs-and-live-verification.md) | done | 1–5 |

## Risks

- **Two concurrent main-agent sessions** (two omp windows) rotate the primary against each other
  every turn; each rotation resends a full transcript. Correct but slow; documented, not solved.
- **Deleting by URL depends on the active panel row** (`aria-current=page`); a Muse UI change
  breaks deletion. Failures keep the thread registered and retry with backoff, so the worst case
  is extra threads, never deleting the wrong one.
- **Warm threads count against Muse quota** (one short turn each); unchanged from today.

## Validation decisions (user, 2026-10-11)

1. Tool-less requests go to a **side** thread; only a request carrying a delegation tool claims or
   rotates the primary.
2. The 12 uncommitted files are reviewed, tested, given back their `build` script, and committed
   as their own feature commit **before** phase 1 (done by the implementer, not stashed).
3. Cap overflow **retires the least-recently-used idle side thread**; no request waits on the cap.
