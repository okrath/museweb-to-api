import type { Locator, Page } from "playwright";
import type { CleanThreadsResult } from "../core/types.js";
import type { DriverContext } from "./page-driver.js";
import { threadRowsScript, type ThreadRow } from "./page-scripts.js";
import { mainChatRowPattern, selectors, threadDeleteItemPattern } from "./selectors.js";
/** Side chats kept before the oldest ones are deleted as new ones are created. */
export const MAX_SIDE_THREADS = 10;

const HOVER_RETRIES = 10;
const HOVER_RETRY_MS = 400;
const AFTER_DELETE_WAIT_MS = 700;

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
/** Deletes the single oldest side chat via its row menu. Throws on any unexpected page state. */
async function deleteOldestSideThread(page: Page): Promise<void> {
  const rows = await sideRows(page);
  const oldest = rows.at(-1);
  if (!oldest) throw new Error("no side-chat row left to delete");
  await deleteSideThread(page, oldest);
}

/**
 * Keeps the side-chat panel from growing without bound: every new API conversation opens a new
 * Muse side chat (see `openConversation` in page-driver.ts) and nothing deletes them on its own.
 * Called once after a turn creates a new thread. Best-effort and never throws: a failed cleanup
 * must not fail the turn that triggered it, only skip housekeeping for this round. On any
 * unexpected page state the first delete attempt throws, which is caught here and logged once.
 */
export async function enforceThreadCap(page: Page, ctx: DriverContext, cap = MAX_SIDE_THREADS): Promise<void> {
  try {
    let rows = await sideRows(page);
    while (rows.length > cap) {
      await deleteOldestSideThread(page);
      rows = await sideRows(page);
    }
  } catch (err) {
    ctx.log.warn({ err: err instanceof Error ? err.message : String(err) }, "Side-chat cleanup skipped");
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
