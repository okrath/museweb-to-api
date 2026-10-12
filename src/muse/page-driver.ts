import type { Logger } from "pino";
import type { Page } from "playwright";
import type { GatewayConfig } from "../config.js";
import type { DriverStatus, MuseDriver, TurnEvent, TurnInput, UsageOutcome } from "../core/types.js";
import { MuseBrowser } from "./browser.js";
import { claimedThreads } from "./new-thread.js";
import { type DriverContext, toTurnError, type TurnTrace, waitForComposer } from "./page-context.js";
import { domReportScript, type DomReport } from "./page-scripts.js";
import { conversationIdFromUrl, selectors } from "./selectors.js";
import { deleteAllSideThreads, deleteThreadAt } from "./thread-cleanup.js";
import { executeTurn } from "./turn.js";
import { readUsage } from "./usage.js";

export {
  toTurnError,
  TurnError,
  waitForComposer,
  type DriverContext,
  type TurnErrorKind,
  type TurnTrace,
  type TurnTraceEntry,
} from "./page-context.js";
export { executeTurn } from "./turn.js";

export interface MuseDriverOptions {
  config: GatewayConfig;
  log: Logger;
  browser?: MuseBrowser;
}

export interface BrowserMuseDriver extends MuseDriver {
  browser: MuseBrowser;
  /** Runs a turn on a specific tab while reporting every stage; used by `pnpm muse:probe`. */
  runTracedTurn(page: Page, input: TurnInput, emit: (event: TurnEvent) => void, trace: TurnTrace): Promise<void>;
  domReport(page: Page): Promise<DomReport>;
}

export function createMuseDriver(options: MuseDriverOptions): BrowserMuseDriver {
  const { config, log } = options;
  const browser =
    options.browser ??
    new MuseBrowser({
      profileDir: `${config.dataDir}/browser-profile`,
      headless: config.headless,
      channel: config.browserChannel,
      maxPages: config.maxConcurrentTurns,
      slowSnapshotMs: config.slowSnapshotMs,
      log,
    });
  const ctx: DriverContext = {
    config,
    log,
    openElsewhere: (page, conversationId) => browser.conversationOpenElsewhere(page, conversationId, config.museUrl),
  };

  async function acquire(conversationId: string | undefined): Promise<Page> {
    if (conversationId) {
      const parked = browser.idlePageAt(conversationId);
      if (parked && (await browser.markBusy(parked))) return parked;
    }
    return browser.acquirePage();
  }

  return {
    browser,
    async runTurn(input, emit) {
      let page: Page | undefined;
      const startedAt = Date.now();
      try {
        page = await acquire(input.conversationId);
        const result = await executeTurn(page, ctx, input, emit);
        if (result.snapshotMs !== undefined) {
          browser.noteSnapshotMs(page, result.snapshotMs);
        }
        log.info(
          {
            requestId: input.requestId,
            mode: input.mode,
            resumed: Boolean(input.conversationId),
            chars: result.text.length,
            ms: Date.now() - startedAt,
            snapshotMs: result.snapshotMs,
          },
          "Muse turn completed",
        );
      } catch (err) {
        const turnError = toTurnError(err);
        log.warn({ requestId: input.requestId, kind: turnError.kind, err: turnError.message }, "Muse turn failed");
        emit({ type: "error", kind: turnError.kind, message: turnError.message, retryAfterSec: turnError.retryAfterSec });
        emit({ type: "done", stopReason: "error" });
      } finally {
        if (page) browser.releasePage(page);
      }
    },
    async runTracedTurn(page, input, emit, trace) {
      try {
        await executeTurn(page, ctx, input, emit, trace);
      } catch (err) {
        const turnError = toTurnError(err);
        emit({ type: "error", kind: turnError.kind, message: turnError.message, retryAfterSec: turnError.retryAfterSec });
        emit({ type: "done", stopReason: "error" });
      }
    },
    async getUsage(): Promise<UsageOutcome> {
      let page: Page | undefined;
      try {
        page = await browser.acquirePage();
        const report = await readUsage(page, ctx);
        return { ok: true, report };
      } catch (err) {
        const turnError = toTurnError(err);
        log.warn({ err: turnError.message }, "Muse usage lookup failed");
        return { ok: false, kind: turnError.kind, message: turnError.message, retryAfterSec: turnError.retryAfterSec };
      } finally {
        if (page) browser.releasePage(page);
      }
    },
    async domReport(page) {
      return page.evaluate(domReportScript, {
        composer: selectors.composer,
        root: selectors.conversationRoot,
        assistant: selectors.assistantMessage,
        user: selectors.userMessage,
      });
    },
    async cleanAllThreads(onProgress) {
      let page: Page | undefined;
      try {
        page = await browser.openDedicatedPage();
        if (!page.url().startsWith(config.museUrl)) {
          await page.goto(config.museUrl, { waitUntil: "domcontentloaded" });
        }
        await waitForComposer(page, config.museUrl, 20_000).catch(() => undefined);
        const result = await deleteAllSideThreads(page, onProgress);
        // It removes every side chat and reports titles, not URLs, so forget them all.
        claimedThreads.clear();
        return result;
      } finally {
        if (page) await page.close().catch(() => undefined);
      }
    },
    async deleteThread(conversationId: string): Promise<void> {
      const threadUrl = conversationIdFromUrl(conversationId, config.museUrl);
      if (!threadUrl) throw new Error(`Not a Muse side-chat URL: "${conversationId}"`);
      let page: Page | undefined;
      try {
        page = await browser.acquirePage();
        await deleteThreadAt(page, threadUrl, waitForComposer);
        claimedThreads.delete(threadUrl);
      } finally {
        if (page) browser.releasePage(page);
      }
    },
    async status(): Promise<DriverStatus> {
      return { browserOpen: browser.isOpen, activeTurns: browser.busyCount, maxConcurrentTurns: config.maxConcurrentTurns };
    },
    async close() {
      await browser.close();
    },
  };
}
