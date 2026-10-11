---
phase: 1
title: "Thread registry and classification"
status: pending
priority: P1
effort: "3h"
dependencies: []
---

# Phase 1: Thread registry and classification

## Goal
A persistent record of every thread the gateway owns (role, last turn end, in-flight state,
retirement) plus a pure function that classifies a request as primary or side.

## Files to Create / Modify
- Create: `src/sessions/thread-registry.ts` — `ThreadRegistry` over `JsonStore` (`data/threads.json`).
- Create: `src/router/thread-role.ts` — `threadRole(req, primaryToolNames): "primary" | "side"`.
- Modify: `src/config.ts` — `PRIMARY_TOOL_NAMES` (default `task,Task,Agent`),
  `SIDE_THREAD_IDLE_SEC` (default 300), `MAX_SIDE_THREADS` (default 10).
- Modify: `src/sessions/session-store.ts` — `deleteByConversation(conversationId): number`.
- Create: `tests/sessions/thread-registry.test.ts`, `tests/router/thread-role.test.ts`.

## Row shape
```ts
interface ThreadRow {
  conversationId: string;
  role: "primary" | "side" | "retired";
  lastUsedAt: number;     // end of the last finished turn
  inFlight: number;       // turns currently running on it (not persisted as truth, see below)
  retireAttempts?: number;
  retryAfter?: number;
}
```
At most one row has `role: "primary"`.

## Tasks & Steps
1. `threadRole`: primary when any `req.tools[].name` is in the configured set; otherwise side,
   including tool-less requests.
2. `ThreadRegistry` methods, each a few lines:
   - `primary()`; `setPrimary(id, now)` → returns the previous primary id, marked `retired`.
   - `touchSide(id, now)`; `begin(id)` / `end(id, now)` for the in-flight counter.
   - `retire(id)`; `retirable(now, idleMs, cap)` → ids safe to delete: `retired` rows plus idle
     side rows, plus least-recently-used idle side rows over `cap`; never a row with `inFlight > 0`.
   - `forget(id)` after a confirmed delete; `noteRetireFailure(id, now)` → backoff
     (60 s × attempts, capped at 10 min).
   - `clear()` for `clean-threads`.
3. On load, reset every `inFlight` to 0 (a persisted in-flight count is stale after a restart).
4. `SessionStore.deleteByConversation` prunes rows whose `conversationId` matches.

## Verification
- `pnpm exec vitest run tests/sessions/thread-registry.test.ts tests/router/thread-role.test.ts`
- Cases: omp main tool set → primary; omp subagent set (`glob,grep,read,web_search,yield`) → side;
  `Agent` (Claude Code) → primary; in-flight rows never retirable; LRU over-cap pick; restart
  resets in-flight; backoff respected.
