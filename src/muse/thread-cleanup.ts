import type { Locator, Page } from "playwright";
import type { CleanThreadsResult } from "../core/types.js";
import { threadRowsScript, type ThreadRow } from "./page-scripts.js";
import { conversationIdFromUrl, mainChatRowPattern, selectors, threadDeleteItemPattern } from "./selectors.js";

const HOVER_RETRIES = 10;
const HOVER_RETRY_MS = 400;
const AFTER_DELETE_WAIT_MS = 700;
const ACTIVE_ROW_SETTLE_MS = 3_000;

async function sideRows(page: Page): Promise<ThreadRow[]> {
  const rows = await page.evaluate(threadRowsScript, { row: selectors.threadRow });
  return rows.filter((row) => !mainChatRowPattern.test(row.text));
}

/** The menu trigger only renders on hover/focus of its row; retries absorb the panel's own re-renders. */
async function revealRowMenuButton(page: Page, row: Locator): Promise<Locator | undefined> {
  const button = row.locator(selectors.threadRowMenuButton.join(","));
  for (let attempt = 0; attempt < HOVER_RETRIES; attempt++) {
    await row.hover().catch(() => undefined);
    if (await button.isVisible().catch(() => false)) return button;
    await page.waitForTimeout(HOVER_RETRY_MS);
  }
  return undefined;
}

/** Deletes a single side chat via its row menu. Throws on any unexpected page state. */
export async function deleteSideThread(page: Page, target: ThreadRow): Promise<void> {
  // Locate by href if available, fallback to nth(index)
  let row = target.href
    ? page.locator(selectors.threadRow.join(",")).filter({ has: page.locator(`a[href="${target.href}"]`) }).first()
    : page.locator(selectors.threadRow.join(",")).nth(target.index);

  if (!(await row.isVisible().catch(() => false))) {
    row = page.locator(selectors.threadRow.join(",")).nth(target.index);
  }

  await row.scrollIntoViewIfNeeded().catch(() => undefined);
  const menuButton = await revealRowMenuButton(page, row);
  if (!menuButton) throw new Error(`"More thread actions" never became visible for "${target.text}"`);
  await menuButton.click();

  const deleteItem = page.locator('[role="menuitem"]', { hasText: threadDeleteItemPattern }).first();
  if (!(await deleteItem.isVisible().catch(() => false))) {
    await page.keyboard.press("Escape").catch(() => undefined);
    throw new Error(`Delete menu item not found for "${target.text}"`);
  }
  const before = (await sideRows(page)).length;
  await deleteItem.click();
  await page.waitForTimeout(400);

  // Wait up to 2.5s for the delete confirm dialog button
  const confirmButton = page
    .locator(selectors.threadDeleteConfirmDialog.join(","))
    .locator("button")
    .filter({ hasText: /delete/i })
    .first();

  const hasConfirm = await confirmButton.waitFor({ state: "visible", timeout: 2500 }).then(() => true).catch(() => false);
  if (hasConfirm) {
    await confirmButton.click();
  } else {
    const fallbackDeleteButton = page.locator("button").filter({ hasText: /^delete$/i }).first();
    if (await fallbackDeleteButton.isVisible().catch(() => false)) {
      await fallbackDeleteButton.click();
    }
  }

  // Wait for deletion animation and DOM update
  await page.waitForTimeout(AFTER_DELETE_WAIT_MS);

  // Poll up to 4s to verify the item is gone
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const rows = await sideRows(page);
    const gone = target.href
      ? !rows.some((r) => r.href === target.href)
      : rows.length < before || rows[0]?.text !== target.text || !rows.some((r) => r.text === target.text);
    if (gone) return;
    await page.waitForTimeout(350);
  }

  const finalRows = await sideRows(page);
  const stillThere = target.href
    ? finalRows.some((r) => r.href === target.href)
    : finalRows.some((r) => r.text === target.text) && finalRows.length >= before;
  if (stillThere) {
    throw new Error(`thread "${target.text}" (${target.href ?? "no-href"}) is still present after delete confirm`);
  }
}
export interface ThreadDeletionCheck {
  currentUrl: string;
  targetUrl: string;
  museUrl: string;
  /** Whether the reloaded panel marks a row as the open thread (`aria-current="page"`). */
  activeRowPresent: boolean;
}

/**
 * After reloading a deleted thread's URL, the thread is gone when Muse redirected away from it or
 * no panel row claims to be the open thread. Titles are not compared: Muse titles are not unique
 * (every warm thread starts from the same prompt), so a matching title elsewhere proves nothing.
 */
export function isThreadDeleted(check: ThreadDeletionCheck): boolean {
  const current = conversationIdFromUrl(check.currentUrl, check.museUrl);
  const target = conversationIdFromUrl(check.targetUrl, check.museUrl);
  return current !== target || !check.activeRowPresent;
}

/**
 * Deletes the thread at the given URL using the active-row method: navigates to the thread,
 * ensures the panel is open, locates the active row ([aria-current="page"]), clicks Delete via
 * its menu and confirms the dialog. Then reloads the URL and verifies the thread is gone.
 * Throws on failure. Never falls back to an index or href.
 */
export async function deleteThreadAt(
  page: Page,
  url: string,
  // Passed in rather than imported: page-driver.ts already imports this module.
  waitForComposerFn: (page: Page, museUrl: string) => Promise<unknown>,
): Promise<void> {
  const museUrl = new URL(url).origin;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForComposerFn(page, museUrl);
  await ensureThreadPanelOpen(page);

  const activeRow = page.locator(selectors.threadActiveRow.join(",")).first();
  await activeRow.waitFor({ state: "attached", timeout: 5000 }).catch(() => undefined);
  const count = await page.locator(selectors.threadActiveRow.join(",")).count().catch(() => 0);
  if (count === 0) {
    throw new Error(`Active thread row not found in side panel for ${url}`);
  }

  await activeRow.scrollIntoViewIfNeeded().catch(() => undefined);
  if (!(await activeRow.isVisible().catch(() => false))) {
    throw new Error(`Active thread row not visible in side panel for ${url}`);
  }

  const title = (await activeRow.innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 80);

  const menuButton = await revealRowMenuButton(page, activeRow);
  if (!menuButton) {
    throw new Error(`"More thread actions" never became visible for active thread at ${url}`);
  }
  await menuButton.click();

  const deleteItem = page.locator('[role="menuitem"]', { hasText: threadDeleteItemPattern }).first();
  const deleteItemVisible = await deleteItem.waitFor({ state: "visible", timeout: 2500 }).then(() => true).catch(() => false);
  if (!deleteItemVisible) {
    await page.keyboard.press("Escape").catch(() => undefined);
    throw new Error(`Delete menu item not found for active thread at ${url}`);
  }
  await deleteItem.click();

  // Wait for the delete confirm dialog and its confirm button
  const confirmDialog = page.locator(selectors.threadDeleteConfirmDialog.join(",")).first();
  const confirmButton = confirmDialog.locator("button").filter({ hasText: /delete/i }).first();
  const hasConfirm = await confirmButton.waitFor({ state: "visible", timeout: 2500 }).then(() => true).catch(() => false);
  if (!hasConfirm) {
    throw new Error(`Delete confirmation dialog button not found for active thread at ${url}`);
  }
  await confirmButton.click();

  // Wait for confirm dialog to close or active row to detach
  await Promise.race([
    confirmDialog.waitFor({ state: "hidden", timeout: 4000 }).catch(() => undefined),
    activeRow.waitFor({ state: "detached", timeout: 4000 }).catch(() => undefined),
  ]);

  // Reload the thread URL. Success only when the page no longer shows that thread.
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await ensureThreadPanelOpen(page);
  // The panel renders its rows asynchronously; give the active row a moment before calling it gone.
  const activeRowPresent = await page
    .locator(selectors.threadActiveRow.join(","))
    .first()
    .waitFor({ state: "attached", timeout: ACTIVE_ROW_SETTLE_MS })
    .then(() => true)
    .catch(() => false);

  const deleted = isThreadDeleted({ currentUrl: page.url(), targetUrl: url, museUrl, activeRowPresent });

  if (!deleted) {
    throw new Error(`thread "${title}" at ${url} is still present after deletion`);
  }
}

/** Ensures the side-chat panel is open before querying or clicking thread rows. */
export async function ensureThreadPanelOpen(page: Page, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let rows = await page.evaluate(threadRowsScript, { row: selectors.threadRow });
  if (rows.some((row) => row.visible)) return;

  for (const selector of selectors.threadPanelTrigger) {
    const trigger = page.locator(selector).first();
    if (await trigger.isVisible().catch(() => false)) {
      await trigger.click().catch(() => undefined);
      break;
    }
  }

  while (Date.now() < deadline) {
    rows = await page.evaluate(threadRowsScript, { row: selectors.threadRow });
    if (rows.some((row) => row.visible)) return;
    await page.waitForTimeout(300);
  }
}

/**
 * Deletes every side-chat thread until none remain.
 * Continuously deletes the first side-chat row until the side-chat list is empty.
 */
export async function deleteAllSideThreads(
  page: Page,
  onProgress?: (progress: { deleted: number; totalKnown: number; title: string }) => void,
): Promise<CleanThreadsResult> {
  await ensureThreadPanelOpen(page);
  const titles: string[] = [];
  const failedKeys = new Set<string>();

  while (true) {
    const currentRows = await sideRows(page);
    if (currentRows.length === 0) break;

    // Find first side-chat row that hasn't permanently failed
    const target = currentRows.find((r) => {
      const key = r.href ?? `${r.index}:${r.text}`;
      return !failedKeys.has(key);
    });

    if (!target) {
      // All remaining visible rows failed after retries
      break;
    }

    const key = target.href ?? `${target.index}:${target.text}`;
    let deleted = false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await deleteSideThread(page, target);
        deleted = true;
        titles.push(target.text);
        onProgress?.({ deleted: titles.length, totalKnown: currentRows.length, title: target.text });
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Attempt ${attempt} to delete "${target.text}" failed: ${msg}`);
        await page.keyboard.press("Escape").catch(() => undefined);
        await page.waitForTimeout(600);
        // Recheck if it got removed despite the error
        const checkRows = await sideRows(page);
        const stillThere = target.href
          ? checkRows.some((r) => r.href === target.href)
          : checkRows.some((r) => r.text === target.text);
        if (!stillThere) {
          deleted = true;
          titles.push(target.text);
          onProgress?.({ deleted: titles.length, totalKnown: currentRows.length, title: target.text });
          break;
        }
      }
    }

    if (!deleted) {
      console.warn(`Skipping thread "${target.text}" after 3 failed attempts, continuing with next thread`);
      failedKeys.add(key);
    }
  }

  return { deleted: titles.length, titles };
}
