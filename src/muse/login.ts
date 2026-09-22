import type { Logger } from "pino";
import type { GatewayConfig } from "../config.js";
import { MuseBrowser } from "./browser.js";
import { waitForComposer } from "./page-driver.js";
import { isSignedInUrl } from "./selectors.js";

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 2_000;

/**
 * Opens the persistent profile in a visible window so the user can sign in to Muse once.
 * The gateway later reuses the same profile headlessly.
 */
export async function runLogin(config: GatewayConfig, log: Logger): Promise<void> {
  const browser = new MuseBrowser({
    profileDir: `${config.dataDir}/browser-profile`,
    headless: false,
    channel: config.browserChannel,
    maxPages: 1,
    log,
  });
  const page = await browser.acquirePage();
  await page.goto(config.museUrl, { waitUntil: "domcontentloaded" });

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let announced = false;
  try {
    while (Date.now() < deadline) {
      if (page.isClosed()) throw new Error("the login window was closed before Muse finished signing in");
      const url = page.url();
      if (isSignedInUrl(url, config.museUrl)) {
        const composer = await waitForComposer(page, config.museUrl, 3_000).catch(() => undefined);
        if (composer) {
          log.info({ url }, "Muse is signed in; the profile is saved for the gateway");
          return;
        }
        if (!announced) {
          announced = true;
          log.info({ url }, "Sign in to Muse in the browser window; this command finishes automatically once the chat composer appears");
        }
      } else if (!announced) {
        announced = true;
        log.info({ url }, "Sign in to Muse in the browser window; this command finishes automatically once the chat composer appears");
      }
      await page.waitForTimeout(POLL_MS);
    }
    throw new Error("timed out waiting for the Muse sign-in to complete");
  } finally {
    await browser.close();
  }
}
