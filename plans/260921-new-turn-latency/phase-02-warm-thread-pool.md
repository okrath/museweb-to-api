# Phase 2 — warm side-chat pool

## Context

A new API conversation currently posts into `/thread/new`, waits for Muse to create the side chat
(19–40 s), opens it and reads the reply: 55 s measured. A follow-up into an existing
`/thread/<uuid>` takes 6.5 s. Pre-creating side chats while the gateway is idle lets a new
conversation take the follow-up path. Read `docs/architecture.md`, `docs/muse-driver.md`,
`src/router/route-request.ts`, `src/muse/page-driver.ts` (only to understand `runTurn`; do not
change it), `src/sessions/session-store.ts`, `src/store/json-store.ts`, `tests/e2e/gateway.test.ts`,
`tests/helpers/*.ts`.

## Requirements

1. **Pool store.** `src/router/warm-pool.ts` keeps a list of ready side chats
   `{ conversationId, createdAt }` in `DATA_DIR/warm-threads.json` via `JsonStore`. Entries older
   than `SESSION_TTL_SEC` are dropped on load and on take.
2. **Warming.** When the pool holds fewer than `WARM_THREADS` entries (config, default `1`,
   `0` disables), the gateway creates one by running `driver.runTurn` with no `conversationId`,
   mode `default`, and the fixed prompt
   `Session start. Reply with exactly: Ready.` It records the `conversation` event's id. Rules:
   - Refill starts immediately when a client turn takes a warm thread, running in parallel with
     that turn on its own tab, so the next new conversation also finds a warm thread. Warming runs
     one thread at a time, takes a turn slot like any turn but never waits for one (if
     `slots.acquire` cannot grant immediately, it retries on the next check), so client requests
     are never delayed by it. It also re-checks after every completed client turn and on a 30 s
     interval (timer `unref`'d). Document in README that `MAX_CONCURRENT_TURNS` should be one
     higher than the desired client concurrency when the pool is enabled.
   - A warming failure is logged at warn level and retried on the next check with a 60 s backoff;
     never loop hot.
   - Warming never starts before the server is listening, and stops on shutdown.
3. **Consumption.** In `routeRequest`, when there is no session to resume and the pool has an entry,
   take it and run the turn with that `conversationId` and the *full* transcript
   (`renderTranscript(req.messages)` without `resume`). The session store then records the
   fingerprint → that conversation id exactly as today. `RouteMeta` gains `warmThread: boolean`
   and the response carries `x-mta-warm-thread: 0|1`.
4. **Fallback.** If a warm-thread turn fails before producing any content with an error kind other
   than `rate_limit`/`auth`, discard that entry and rerun the request as a cold `/thread/new` turn,
   the same way a dead resumed session is retried today (extend the existing hold-until-content
   mechanism; do not duplicate it).
5. **Wiring.** `src/config.ts` (`WARM_THREADS`), `.env.example`, `src/server.ts` /
   `src/index.ts` (construct the pool, start after `listen`, stop on shutdown), `tests/helpers`
   (the fake driver must return a distinct `conversationId` per new-thread turn so pool tests can
   assert reuse), `README.md` (Sessions and cache + Configuration table), `docs/architecture.md`
   (request flow step for the pool).

## Files you may modify

`src/router/warm-pool.ts` (new), `src/router/route-request.ts`, `src/router/slots.ts` (only if an
`activeCount` accessor is missing), `src/api/chat-handler.ts` (header only), `src/config.ts`,
`src/server.ts`, `src/index.ts`, `.env.example`, `README.md`, `docs/architecture.md`,
`tests/**`. Do not modify anything under `src/muse/` or `src/protocol/`.

## Acceptance criteria

- `pnpm lint`, `pnpm test`, `pnpm build` green.
- New e2e tests with the fake driver: (a) pool warms to `WARM_THREADS` after start without a
  client request; (b) a new conversation consumes a warm thread (`x-mta-warm-thread: 1`, driver
  received that `conversationId` and the full transcript), and the pool refills; (c) a follow-up
  to that conversation still resumes it (`x-mta-session-reused: 1`); (d) a warm thread that errors
  before content falls back to a cold turn transparently; (e) `WARM_THREADS=0` never warms and
  never sets the header to `1`; (f) warming does not start while a client turn is active.
- Existing tests unchanged in behaviour.
- Files stay under ~300 lines; plain functions, no classes beyond what the store pattern already uses.

## Constraints

- Keep KISS/DRY; reuse `JsonStore`, `TurnSlots`, `createEventChannel`, `renderTranscript`.
- No fake data or mocks in `src/`.
- Conventional commit style if you commit; do not commit `.env` or `data/`.
- Do not put plan or phase identifiers in code comments or test names; describe behaviour.

## Validation you must run

`pnpm lint && pnpm test && pnpm build`. Do not run `pnpm muse:*` or start the real gateway; the
live measurement is done by the reviewer.

## Report

Write `plans/260921-new-turn-latency/reports/phase-02-report.md` ending with:

```
Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
Summary: one or two sentences
Concerns/Blockers: optional
```

## Rollback

Revert the commit(s) of this phase; `WARM_THREADS=0` also disables the feature at runtime.
