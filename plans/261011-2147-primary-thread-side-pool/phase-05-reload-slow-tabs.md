---
phase: 5
title: "Reload slow tabs"
status: pending
priority: P2
effort: "2h"
dependencies: []
---

# Phase 5: Reload slow tabs

## Goal
Measure how long a tab takes to read its page, and reload a tab before its next turn once that
time crosses a calibrated threshold.

## Files to Create / Modify
- Modify: `src/muse/page-driver.ts` — time each `snapshot()` in `readReply`; report the median for
  the turn in the `Muse turn completed` log line (`snapshotMs`), and pass it to the browser.
- Modify: `src/muse/browser.ts` — `noteSnapshotMs(page, ms)` flags the tab when over threshold;
  `acquirePage` / `markBusy` reload a flagged tab (`page.reload`, wait for composer) before
  handing it out, logging the measured time.
- Modify: `src/config.ts` — `SLOW_SNAPSHOT_MS` (default set in step 2).

## Tasks & Steps
1. Ship the measurement first; run an omp session with a subagent through the gateway and record
   `snapshotMs` for short and long threads.
2. Set the default to roughly 3× the typical healthy median from step 1; write the numbers into
   this phase file.
3. Implement the flag-and-reload.

## Verification
- Unit: a tab marked over threshold is reloaded once on next acquire, then cleared.
- Live: the log shows `snapshotMs` per turn; forcing a low threshold triggers one reload.
