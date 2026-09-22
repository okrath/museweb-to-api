import type { Locator, Page } from "playwright";
import type { DriverContext } from "./page-driver.js";
import { threadRowsScript, type ThreadRow } from "./page-scripts.js";
import { mainChatRowPattern, selectors, threadDeleteConfirmPattern, threadDeleteItemPattern } from "./selectors.js";

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

/** Deletes the single oldest side chat via its row menu. Throws on any unexpected page state. */
async function deleteOldestSideThread(page: Page): Promise<void> {
  const rows = await sideRows(page);
  const oldest = rows.at(-1);
  if (!oldest) throw new Error("no side-chat row left to delete");

  const row = page.locator(selectors.threadRow.join(",")).nth(oldest.index);
  await row.scrollIntoViewIfNeeded().catch(() => undefined);
  const menuButton = await revealRowMenuButton(page, row);
  if (!menuButton) throw new Error(`"More thread actions" never became visible for "${oldest.text}"`);
  await menuButton.click();

  const deleteItem = page.locator('[role="menuitem"]', { hasText: threadDeleteItemPattern }).first();
  if (!(await deleteItem.isVisible().catch(() => false))) {
    await page.keyboard.press("Escape").catch(() => undefined);
    throw new Error(`Delete menu item not found for "${oldest.text}"`);
  }
  const before = (await sideRows(page)).length;
  await deleteItem.click();

  const dialog = page
    .locator(selectors.threadDeleteConfirmDialog.join(","))
    .filter({ hasText: threadDeleteConfirmPattern })
    .first();
  if (await dialog.isVisible().catch(() => false)) {
    const confirmButton = dialog.locator("button", { hasText: threadDeleteItemPattern }).first();
    if (!(await confirmButton.isVisible().catch(() => false))) {
      throw new Error(`Delete confirm button not found for "${oldest.text}"`);
    }
    await confirmButton.click();
  }

  await page.waitForTimeout(AFTER_DELETE_WAIT_MS);
  const after = (await sideRows(page)).length;
  if (after >= before) {
    throw new Error(`side-chat count did not decrease after deleting "${oldest.text}" (before ${before}, after ${after})`);
  }
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
