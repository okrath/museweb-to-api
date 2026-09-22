import type { Locator, Page } from "playwright";
import type { UsageReport } from "../core/types.js";
import { TurnError, waitForComposer, type DriverContext } from "./page-driver.js";
import { usageScript } from "./page-scripts.js";
import { selectors, settingsMenuItemPattern } from "./selectors.js";

const MENU_WAIT_MS = 3_000;
const DIALOG_WAIT_MS = 5_000;

async function waitVisible(locator: Locator, timeoutMs: number): Promise<boolean> {
  return locator
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

async function closeSettings(page: Page): Promise<void> {
  const closeButton = page.locator(selectors.settingsCloseButton.join(",")).first();
  if (await closeButton.isVisible().catch(() => false)) {
    await closeButton.click().catch(() => undefined);
    return;
  }
  await page.keyboard.press("Escape").catch(() => undefined);
}

/**
 * Opens Settings > General (the account dock menu, then the "Settings" item) and reads its
 * usage meters. Always closes the dialog before returning, even on failure, since the tab is
 * reused for chat turns afterwards.
 */
export async function readUsage(page: Page, ctx: DriverContext): Promise<UsageReport> {
  // A freshly opened tab starts at about:blank; the dock chrome only exists on a muse.ai page.
  // Reuse whatever muse.ai page the tab is already on instead of opening a new side chat.
  const museOrigin = new URL(ctx.config.museUrl).origin;
  const currentOrigin = new URL(page.url(), ctx.config.museUrl).origin;
  if (currentOrigin !== museOrigin) {
    await page.goto(ctx.config.museUrl, { waitUntil: "domcontentloaded" });
  }
  await waitForComposer(page, ctx.config.museUrl);

  const dockButton = page.locator(selectors.dockMoreButton.join(",")).first();
  if (!(await dockButton.isVisible().catch(() => false))) {
    throw new TurnError("browser", 'Muse account menu button not found; run "pnpm muse:probe" and update dockMoreButton in src/muse/selectors.ts');
  }
  await dockButton.click();

  const settingsItem = page.locator('[role="menuitem"]', { hasText: settingsMenuItemPattern }).first();
  if (!(await waitVisible(settingsItem, MENU_WAIT_MS))) {
    await page.keyboard.press("Escape").catch(() => undefined);
    throw new TurnError(
      "browser",
      'Muse "Settings" menu item not found; run "pnpm muse:probe" and update settingsMenuItemPattern in src/muse/selectors.ts',
    );
  }
  await settingsItem.click();

  const progressbars = page.locator(selectors.usageProgressbar.join(","));
  if (!(await waitVisible(progressbars, DIALOG_WAIT_MS))) {
    await closeSettings(page);
    throw new TurnError("browser", 'Muse usage panel not found; run "pnpm muse:probe" and update usageProgressbar in src/muse/selectors.ts');
  }

  const report = await page.evaluate(usageScript, { progressbar: selectors.usageProgressbar });
  await closeSettings(page);

  if (report.entries.length === 0) {
    throw new TurnError("browser", "Muse usage panel had no readable entries; run \"pnpm muse:probe\" and update usage selectors in src/muse/selectors.ts");
  }
  return report;
}
