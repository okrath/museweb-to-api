import type { Locator, Page } from "playwright";
import { ThreadDeleteRefusedError, type CleanThreadsResult } from "../core/types.js";
import { threadRowsScript, type ThreadRow } from "./page-scripts.js";
import {
  conversationIdFromUrl,
  mainChatRowPattern,
  selectors,
  threadDeletedPattern,
  threadDeleteFailedPattern,
  threadDeleteItemPattern,
} from "./selectors.js";

const HOVER_RETRIES = 10;
const HOVER_RETRY_MS = 400;
const ACTIVE_ROW_SETTLE_MS = 3_000;
const TOAST_WAIT_MS = 5_000;
const TOAST_CLEAR_MS = 8_000;
const SEEN_TOAST_ATTRIBUTE = "data-mta-seen-toast";
const NETWORK_SETTLE_MS = 3_000;
const DELETE_SETTLE_MS = 4_000;
const DELETE_ATTEMPTS = 3;

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
  // Titles repeat and the virtualised panel refills from below, so only Muse's toast proves it.
  const verdict = await deleteViaMenu(page, row, `"${target.text}"`);
  if (verdict !== "deleted") throw new Error(`Muse never confirmed deleting "${target.text}"`);
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

type DeleteVerdict = "deleted" | "refused" | "unknown";

/** Opens the row's menu, chooses Delete, confirms, and reads Muse's toast. */
async function clickDelete(page: Page, row: Locator, label: string): Promise<{ verdict: DeleteVerdict; toast: string }> {
  // A toast left over from the previous delete would otherwise be read as this one's answer, so
  // every toast already on the page is marked and only unmarked ones count below.
  const existing = page.locator(selectors.toast.join(","));
  await existing.first().waitFor({ state: "hidden", timeout: TOAST_CLEAR_MS }).catch(() => undefined);
  await existing.evaluateAll((nodes, attribute) => nodes.forEach((node) => node.setAttribute(attribute, "")), SEEN_TOAST_ATTRIBUTE);
  const toasts = page.locator(selectors.toast.map((selector) => `${selector}:not([${SEEN_TOAST_ATTRIBUTE}])`).join(","));
  const menuButton = await revealRowMenuButton(page, row);
  if (!menuButton) throw new Error(`"More thread actions" never became visible for ${label}`);
  await menuButton.click();

  const deleteItem = page.locator('[role="menuitem"]', { hasText: threadDeleteItemPattern }).first();
  if (!(await deleteItem.waitFor({ state: "visible", timeout: 2500 }).then(() => true).catch(() => false))) {
    await page.keyboard.press("Escape").catch(() => undefined);
    throw new Error(`Delete menu item not found for ${label}`);
  }
  await deleteItem.click();

  const confirmButton = page.locator(selectors.threadDeleteConfirmDialog.join(",")).first().locator("button").filter({ hasText: /delete/i }).first();
  if (await confirmButton.waitFor({ state: "visible", timeout: 2500 }).then(() => true).catch(() => false)) {
    await confirmButton.click();
  } else {
    // A dialog outside `threadDeleteConfirmDialog` still has its plain "Delete" button.
    const fallback = page.locator("button").filter({ hasText: /^delete$/i }).first();
    if (!(await fallback.isVisible().catch(() => false))) {
      throw new Error(`Delete confirmation dialog button not found for ${label}`);
    }
    await fallback.click();
  }

  // Muse answers with a toast either way; it only stays a few seconds, so poll for it.
  const refused = toasts.filter({ hasText: threadDeleteFailedPattern }).first();
  const deleted = toasts.filter({ hasText: threadDeletedPattern }).first();
  const deadline = Date.now() + TOAST_WAIT_MS;
  while (Date.now() < deadline) {
    if (await deleted.isVisible().catch(() => false)) return { verdict: "deleted", toast: "" };
    if (await refused.isVisible().catch(() => false)) {
      return { verdict: "refused", toast: (await refused.innerText().catch(() => "")).replace(/\s+/g, " ").trim() };
    }
    await page.waitForTimeout(250);
  }
  return { verdict: "unknown", toast: "" };
}

/**
 * Deletes one row through its menu. The panel shows rows from cache before the page's link to
 * Muse is up, and a delete sent before that is refused with "Failed to delete side chat" (live
 * 2026-10-12: always at 0 and 1.5 s after load, never at 4 s), so callers wait
 * `DELETE_SETTLE_MS` after loading a page and a refusal is retried after another pause.
 */
async function deleteViaMenu(page: Page, row: Locator, label: string): Promise<DeleteVerdict> {
  let toast = "";
  for (let attempt = 1; attempt <= DELETE_ATTEMPTS; attempt++) {
    const result = await clickDelete(page, row, label);
    if (result.verdict !== "refused") return result.verdict;
    toast = result.toast;
    if (attempt < DELETE_ATTEMPTS) await page.waitForTimeout(DELETE_SETTLE_MS);
  }
  throw new ThreadDeleteRefusedError(`Muse refused to delete ${label}: "${toast}"`);
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
  if (conversationIdFromUrl(page.url(), museUrl) !== conversationIdFromUrl(url, museUrl)) return;
  await ensureThreadPanelOpen(page);

  const activeRow = page.locator(selectors.threadActiveRow.join(",")).first();
  await activeRow.waitFor({ state: "attached", timeout: 5000 }).catch(() => undefined);
  const count = await page.locator(selectors.threadActiveRow.join(",")).count().catch(() => 0);
  if (count === 0) {
    // A deleted thread's URL still opens, with no panel row marked open (seen live 2026-10-11):
    // that is the end state we want. With no side rows at all the selectors may be broken, so
    // that still throws rather than passing for a deletion.
    if ((await sideRows(page)).length > 0) return;
    throw new Error(`Active thread row not found in side panel for ${url}`);
  }

  await activeRow.scrollIntoViewIfNeeded().catch(() => undefined);
  if (!(await activeRow.isVisible().catch(() => false))) {
    throw new Error(`Active thread row not visible in side panel for ${url}`);
  }
  const title = (await activeRow.innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 80);

  await page.waitForTimeout(DELETE_SETTLE_MS);
  // The row count says nothing about success: the virtualised panel refills from below. The
  // reload below decides.
  await deleteViaMenu(page, activeRow, url);
  // Navigating away before the delete request finishes would cancel it.
  await page.waitForLoadState("networkidle", { timeout: NETWORK_SETTLE_MS }).catch(() => undefined);

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
  await page.waitForTimeout(DELETE_SETTLE_MS);
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
        // deleteViaMenu already retried the refusal; more attempts would only repeat it.
        if (err instanceof ThreadDeleteRefusedError) break;
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
