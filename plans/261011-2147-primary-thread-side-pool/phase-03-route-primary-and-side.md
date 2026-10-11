---
phase: 3
title: "Route primary and side requests"
status: pending
priority: P1
effort: "4h"
dependencies: [1, 2]
---

# Phase 3: Route primary and side requests

## Goal
`routeRequest` sends primary requests into the primary thread (rotating when history diverges)
and side requests into their own thread, and records every thread's role and use in the registry.

## Files to Create / Modify
- Modify: `src/router/route-request.ts` — classify, then pick the conversation; mark
  `begin`/`end`; register on finish. Keep the file under ~300 lines by putting helpers in
  `thread-role.ts`.
- Modify: `src/server.ts` / `src/index.ts` — construct `ThreadRegistry`, pass it in `RouteDeps`;
  `clean-threads` also clears `threads.json`.
- Modify: `src/api/chat-handler.ts` — `x-mta-thread-role` response header.
- Create: `tests/e2e/thread-roles.test.ts`.

## Flow
- **Resume (both roles):** unchanged — a session-fingerprint hit continues its thread with only
  the new messages. For a primary request the hit must also be the registry's primary;
  otherwise treat it as divergent.
- **Primary, divergent:** take a warm thread (or a new one), send the full transcript. On a
  successful finish `setPrimary(outcome.conversationId)` and the previous primary becomes
  `retired`, and its session rows are deleted.
- **Side, new:** take a warm thread (or a new one); on finish `touchSide(outcome.conversationId)`.
- **Retry-fresh path:** register the role on `outcome.conversationId` at finish time, not on the
  thread the turn started on; the abandoned thread is retired.
- `begin(id)` before the driver turn when the id is known, `end(id, now)` in `finally`; a new
  thread is registered at finish with `lastUsedAt = now`.

## Tasks & Steps
1. Add `registry` and `primaryToolNames` to `RouteDeps`.
2. Implement the flow above; nudge the reaper (`queueMicrotask(reaper.check)`) after a rotation.
3. Response header `x-mta-thread-role: primary|side`.

## Verification
- e2e with the fake driver:
  - two main-agent turns resume the same id; a new main conversation rotates and retires the old;
  - two parallel side conversations get different ids;
  - the retired primary's session rows are gone;
  - retry-fresh registers the new id and retires the failed one.
- `pnpm test`.
