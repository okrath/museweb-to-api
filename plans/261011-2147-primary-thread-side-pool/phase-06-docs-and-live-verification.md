---
phase: 6
title: "Docs and live verification"
status: completed
priority: P2
effort: "2h"
dependencies: [1, 2, 3, 4, 5]
---

# Phase 6: Docs and live verification

## Goal
Document the new thread model and prove acceptance criteria 1–6 against the real Muse account.

## Files to Create / Modify
- Modify: `README.md` — config rows `PRIMARY_TOOL_NAMES`, `SIDE_THREAD_IDLE_SEC`,
  `MAX_SIDE_THREADS`, `SLOW_SNAPSHOT_MS`; `x-mta-thread-role` header.
- Modify: `docs/architecture.md` — primary/side flow, registry, reaper, slot constraint.
- Modify: `docs/muse-driver.md` — delete-by-URL method and its failure mode.

## Tasks & Steps
1. Run the gateway with `LOG_LEVEL=debug`; two `omp -p --model muse/muse` sessions, each
   delegating to a subagent.
2. Check: main turns share one id; session 2 rotates the primary; the old primary is gone from
   the panel after reload; subagent threads are deleted ~5 min after their last turn.
3. Restart the gateway mid-session; the main agent resumes the same primary.
4. Record results in this file.

## Verification
- `pnpm lint`, `pnpm test`, build.
- Live checklist above, with thread ids from the log.

## Live results (2026-10-11, headless Edge, omp 18.8.7 and curl through the gateway)

| Criterion | Result | Evidence |
|---|---|---|
| 1. Main-agent turns share one thread, also across a restart | **pass** | run 1: four primary turns `resumed: true` on `4f065a1a`; after a gateway restart a follow-up resumed primary `c01e57d7` with `x-mta-session-reused: 1` |
| 2. New main conversation rotates the primary and retires the old one | **pass** (rotation) / **blocked by Muse** (deletion) | `4f065a1a` → `3f2eedb9` → `6b4b53b9` → `c01e57d7`, each previous one marked `retired`; deleting the live ones was refused by Muse, see below |
| 3. Parallel subagents get their own threads | **pass** | subagent turns ran on their own side thread (`5ea442a5`) while the primary stayed on `4f065a1a`; a tool-less or non-delegating request got `x-mta-thread-role: side` |
| 4. Side thread deleted after 5 minutes idle | **pass** (selection) / **blocked by Muse** (deletion) | side `08ae8da7` last used 23:04:09, picked by the reaper at 23:09:25 |
| 5. Gateway never deletes threads it did not create | **pass** | only registry ids were ever attempted |
| 6. Slow tab reloaded | **calibrated, not triggered** | median `snapshotMs` 3–4 ms on every turn; default set to 250 ms (phase 5) |

Defects found live and fixed (commits `bc0695a` and earlier):
- `deleteThreadAt` reported success criteria on titles, which are not unique; it now uses the URL
  and the panel row marked open.
- A deleted thread's URL still opens (no redirect) with no row marked open; that now counts as
  already deleted instead of failing forever. Verified: the reaper cleared `4f065a1a` and
  `5ea442a5`, which had been deleted by hand.
- Muse's refusal ("Failed to delete side chat" sonner toast) is now detected and logged.

**Open: Muse refuses deletes.** Three deletes in a row succeeded (22:50–22:56); from about 22:57
every delete of a still-existing thread was refused with "Failed to delete side chat", including
hours-old warm threads and with a single tab and the gateway stopped. It looks like an
account-side throttle. The reaper keeps those threads registered and retries with backoff
(60 s per attempt, at most 10 minutes); no request is affected. Whether and when the refusals
clear still needs watching on a longer-running gateway.

Observed outside the gateway: Muse sometimes answers the main-agent turn itself instead of
calling `task` ("the task tool isn't available in my toolset"), so a run may have no subagent.
