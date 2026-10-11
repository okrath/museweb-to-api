---
phase: 2
title: "Delete a thread by URL"
status: pending
priority: P1
effort: "3h"
dependencies: []
---

# Phase 2: Delete a thread by URL

## Goal
`MuseDriver.deleteThread(conversationId)` deletes exactly that side thread and confirms it is
gone after a reload, using the method proven live on 2026-10-11: open the thread URL, act on the
panel row with `aria-current="page"`.

## Files to Create / Modify
- Modify: `src/core/types.ts` — optional `deleteThread?(conversationId: string): Promise<void>` on
  `MuseDriver` (throws on failure).
- Modify: `src/muse/thread-cleanup.ts` — `deleteThreadAt(page, url)`; delete `enforceThreadCap`
  and `deleteOldestSideThread`.
- Modify: `src/muse/page-driver.ts` — drop the `enforceThreadCap` call in `executeTurn`; add
  `deleteThread` to the driver object (acquire a pooled tab, run `deleteThreadAt`, release).
- Modify: `src/muse/selectors.ts` — active-row selector (`[aria-current="page"]` within
  `threadRow`) if not already there.
- Modify: `tests/helpers/fake-driver.ts` — record `deletedThreads`, scriptable failure.

## Tasks & Steps
1. `deleteThreadAt`: `goto(url)`, wait for composer, `ensureThreadPanelOpen`, locate the active
   row; if none, throw (never fall back to an index).
2. Open its menu (reuse `revealRowMenuButton`), click the delete item, confirm the dialog.
3. Reload the thread URL. Success only when the page no longer shows that thread (redirect away
   or no active row with the old title). Otherwise throw.
4. Remove `enforceThreadCap` and its call; the registry owns cleanup from now on.
5. Leave `deleteAllSideThreads` (the `clean-threads` command) as is, but note in the report its
   `href`-less false-success bug; it is outside this plan's acceptance criteria.

## Verification
- Unit: fake driver records deletions.
- Live, scratch script: create a thread via `/thread/new`, `deleteThread` it, reload, the row is
  gone; a second thread opened beforehand is still present.
