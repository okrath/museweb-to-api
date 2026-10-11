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

## Results
- **Calibration pending**: Default `SLOW_SNAPSHOT_MS` set to 1500; live browser calibration could not be executed in this environment. Recalibration with a live omp run will record actual healthy read medians and update this default if necessary.
- Pure decision logic implemented in `src/muse/browser.ts`: `computeMedian` (median snapshot calculation), `noteTabSnapshot` (over-threshold evaluation and flagging), `consumeTabReload` (flag consumption and clearing on reload), `reloadSlowPage` (reload and composer wait).
- In `src/muse/page-driver.ts`: each `snapshot()` call in `readReply` is timed, turn median `snapshotMs` is calculated and logged in `Muse turn completed`, and reported to `browser.noteSnapshotMs`.
- In `src/muse/browser.ts`: `acquirePage` and `markBusy` reload flagged slow tabs before handing them out and log `snapshotMs`. The flag is cleared so each slow tab is reloaded only once.
- Unit tests added in `tests/muse/reload-slow-tabs.test.ts` verifying median computation, threshold flagging, single-reload consumption lifecycle, and composer waiting without Playwright.
