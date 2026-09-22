# Reduce new-conversation latency

Status: Phase 1 resolved and Phase 2 implemented and verified live on 2026-09-21 (the user asked
for the warm pool on top of the cleanup); Phase 3 not started. Phase 2 was implemented by Codex
(`gpt-5.6-luna`, reasoning max) via `codex exec -s danger-full-access` (workspace-write falls
back to read-only on this Windows machine and the project needed a `trust_level` entry in
`~/.codex/config.toml`); planning, supervision and review in the Claude session.

## Outcome

A new API conversation (first turn, fresh Muse side chat) should complete in roughly the time of a
follow-up turn (about 7 s measured on 2026-09-21) instead of 55 s.

## Baseline (2026-09-21, gateway on the user's account)

| Turn | Time |
|---|---|
| New side chat, first reply | 55–57 s |
| Follow-up in existing thread | 6.5 s |

Trace breakdown of a new turn: typing and send < 1 s; waiting for the new side-chat row to appear
in the panel 19–40 s (Muse VM processing); opening the thread, "Something went wrong", reload 2–3 s;
reading the reply 1.5 s.

## Constraints and non-goals

- No change to the public API surface or session/cache semantics.
- No workaround of Muse usage limits; no retries that add load to a struggling VM.
- Non-goal: speeding up Muse's own generation time.

## Phases

Stop at the first phase that meets the acceptance criterion; later phases are contingent.

### Phase 1 — clean the oversized main chat (Muse side, no code)

Cause: one 4,321,808-character user message in the main chat pushes the `chat.subscribe` record
over Muse's 4 MB limit, the VM socket reconnects every ~2 s, and every message shows "Delivery not
confirmed". Action: delete that message via the message context menu ("Delete"). Verify: probe
console shows no `Noise response exceeded ... byte limit`; sockets stay open; new-turn time
re-measured with three `pnpm muse:probe --send` runs.

Acceptance: median new turn ≤ 15 s → stop.

Result (2026-09-21): the user cleared the main chat with Muse's `/clear` command (main chat now
4,555 characters). Page load shows no byte-limit errors and one stable VM socket. Three probe turns
(ALPHA/BRAVO/CHARLIE): 5.7 s, 7.1 s, 5.2 s; the new side-chat row appeared after 2.3–4.1 s and the
thread opened on the first attempt every time. Through the gateway: new turn 11.5 s (includes the
first navigation of a cold tab), follow-up 4.6 s. Acceptance met; Phases 2 and 3 are not needed.

### Phase 2 — warm side-chat pool (gateway)

Pre-create side chats while idle so a new conversation takes the follow-up path. See
`phase-02-warm-thread-pool.md`.

Acceptance: median new turn ≤ 10 s with the pool warm; pool refills in the background; tests and
docs updated.

Result (2026-09-21, gateway on the user's account, `WARM_THREADS=1`, `MAX_CONCURRENT_TURNS=2`):
warm-up after start 18 s; new conversation via warm thread 6.1 s (`x-mta-warm-thread: 1`) while
the refill ran in parallel on the second tab (6.1 s) and the pool was full again when the request
returned; follow-up into that thread 3.4 s with `x-mta-session-reused: 1`. Codex report:
`reports/phase-02-report.md`. Review: no changes under `src/muse/` or `src/protocol/`; one
formatting fix in `docs/architecture.md`; 46 tests green.

### Phase 3 — resolve the thread id without the panel (gateway)

Capture the thread id from the `POST /thread/new` server-action response (or another signal) and
navigate directly, skipping the panel wait and the "Something went wrong" reload. Contingent on
Phase 2 leaving the cold path slow and on the response carrying an id. Spec to be written if reached.

## Verification for every phase

`pnpm lint`, `pnpm test`, then three live `pnpm muse:probe --send "Reply with exactly one word: X"`
runs and one gateway run (new turn + follow-up) with timings from the server log.
