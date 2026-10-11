---
phase: 4
title: "Thread reaper"
status: pending
priority: P1
effort: "3h"
dependencies: [1, 2, 3]
---

# Phase 4: Thread reaper

## Goal
A background loop that deletes retired threads, side threads idle for more than 5 minutes, and
least-recently-used idle side threads over the cap of 10 — without ever blocking a request.

## Files to Create / Modify
- Create: `src/router/thread-reaper.ts` — `start()`, `stop()`, `check()`, modeled on
  `WarmThreadPool` (30 s timer, `slots.acquire(0)`, one deletion at a time).
- Modify: `src/router/warm-pool.ts` — `pruneExpired` and `clear()` hand dropped ids to
  `registry.retire` instead of forgetting them (today expired warm threads are only dropped
  locally and stay in Muse).
- Modify: `src/index.ts` — start/stop the reaper beside the warm pool.
- Create: `tests/router/thread-reaper.test.ts`.

## Tasks & Steps
1. `check()`: skip if already running or no free slot; take one id from
   `registry.retirable(now, idleMs, cap)`.
2. `driver.deleteThread(id)`; on success `registry.forget(id)` and
   `sessions.deleteByConversation(id)`; on failure `noteRetireFailure` and log once at warn.
3. Loop until nothing is retirable or no slot is free.
4. Log each deletion at info with role and idle time.

## Verification
- Unit with the fake driver and a fake clock: idle > 300 s deleted, in-flight never deleted,
  over-cap LRU deleted, failure backs off, primary never deleted unless retired, expired warm
  threads are retired.
