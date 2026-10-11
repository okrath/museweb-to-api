---
phase: 6
title: "Docs and live verification"
status: pending
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
