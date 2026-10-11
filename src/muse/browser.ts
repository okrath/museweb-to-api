import type { Logger } from "pino";
import { chromium, type BrowserContext, type Page } from "playwright";
import { selectors } from "./selectors.js";

export interface TabReloadState {
  needsReload: boolean;
  slowSnapshotMs?: number;
}

export function computeMedian(samples: number[]): number | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function noteTabSnapshot(
  state: TabReloadState,
  snapshotMs: number,
  thresholdMs: number,
): boolean {
  if (snapshotMs > thresholdMs) {
    state.needsReload = true;
    state.slowSnapshotMs = snapshotMs;
    return true;
  }
  return false;
}

export function consumeTabReload(
  state: TabReloadState,
): { shouldReload: boolean; slowSnapshotMs?: number } {
  if (!state.needsReload) {
    return { shouldReload: false };
  }
  const ms = state.slowSnapshotMs;
  state.needsReload = false;
  state.slowSnapshotMs = undefined;
  return { shouldReload: true, slowSnapshotMs: ms };
}

export async function reloadSlowPage(
  page: Page,
  log: Pick<Logger, "info">,
  slowSnapshotMs?: number,
): Promise<void> {
  log.info({ url: page.url(), snapshotMs: slowSnapshotMs }, "Reloading slow tab before turn");
  if (!page.isClosed()) {
    await page.reload({ waitUntil: "domcontentloaded" });
    const composerSelector = selectors.composer.join(", ");
    await page.locator(composerSelector).first().waitFor({ state: "visible", timeout: 20_000 });
  }
}

export interface MuseBrowserOptions {
  profileDir: string;
  headless: boolean;
  channel?: string;
  maxPages: number;
  slowSnapshotMs?: number;
  log: Pick<Logger, "info" | "warn" | "error" | "debug">;
}

interface PooledPage extends TabReloadState {
  page: Page;
  busy: boolean;
}
/**
 * Owns one persistent Chromium profile (the signed-in Muse session) and a small pool of
 * tabs. Every tab shares the login but keeps its own conversation.
 */
export class MuseBrowser {
  private context: BrowserContext | null = null;
  private launching: Promise<BrowserContext> | null = null;
  private readonly pool: PooledPage[] = [];
  private readonly slowSnapshotMs: number;

  constructor(private readonly options: MuseBrowserOptions) {
    this.slowSnapshotMs = options.slowSnapshotMs ?? 1500;
  }

  get isOpen(): boolean {
    return this.context !== null;
  }

  get busyCount(): number {
    return this.pool.filter((entry) => entry.busy).length;
  }

  async getContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.launching) return this.launching;
    this.launching = chromium
      .launchPersistentContext(this.options.profileDir, {
        headless: this.options.headless,
        channel: this.options.channel,
        viewport: { width: 1280, height: 900 },
        args: ["--disable-blink-features=AutomationControlled"],
        ignoreDefaultArgs: ["--enable-automation"],
      })
      .then(async (context) => {
        context.setDefaultTimeout(20_000);
        // Functions passed to page.evaluate are serialized from their source. When the gateway
        // runs through tsx/esbuild, that source references an esbuild helper (`__name`) that
        // does not exist inside the page; define a no-op so both tsx and compiled runs work.
        await context.addInitScript("globalThis.__name = globalThis.__name || ((fn) => fn);");
        context.on("close", () => {
          this.options.log.warn("Muse browser context closed");
          this.context = null;
          this.pool.splice(0);
        });
        this.context = context;
        this.options.log.info(
          { profileDir: this.options.profileDir, headless: this.options.headless, channel: this.options.channel ?? "chromium" },
          "Muse browser launched",
        );
        return context;
      })
      .finally(() => {
        this.launching = null;
      });
    return this.launching;
  }

  /** Returns an idle tab, opening a new one when the pool has room. */
  async acquirePage(): Promise<Page> {
    const context = await this.getContext();
    for (const entry of this.pool) {
      if (!entry.busy && !entry.page.isClosed()) {
        entry.busy = true;
        await this.reloadIfSlow(entry);
        return entry.page;
      }
    }
    this.pool.splice(0, this.pool.length, ...this.pool.filter((entry) => !entry.page.isClosed()));
    if (this.pool.length >= this.options.maxPages) {
      throw new Error("no free browser tab (turn slots and tab pool are out of sync)");
    }
    const page = context.pages().find((p) => !this.pool.some((entry) => entry.page === p)) ?? (await context.newPage());
    this.pool.push({ page, busy: true, needsReload: false });
    return page;
  }

  /** Opens a dedicated tab outside the turn pool (e.g. for maintenance or inspection). Caller must close it. */
  async openDedicatedPage(): Promise<Page> {
    const context = await this.getContext();
    return context.newPage();
  }

  releasePage(page: Page): void {
    const entry = this.pool.find((candidate) => candidate.page === page);
    if (entry) entry.busy = false;
  }

  /** Tabs currently parked on a given URL, so a resumed conversation can skip navigation. */
  idlePageAt(url: string): Page | undefined {
    return this.pool.find((entry) => !entry.busy && !entry.page.isClosed() && entry.page.url().startsWith(url))?.page;
  }

  async markBusy(page: Page): Promise<boolean> {
    const entry = this.pool.find((candidate) => candidate.page === page);
    if (!entry || entry.busy) return false;
    entry.busy = true;
    await this.reloadIfSlow(entry);
    return true;
  }

  noteSnapshotMs(page: Page, ms: number): void {
    const entry = this.pool.find((candidate) => candidate.page === page);
    if (!entry) return;
    if (noteTabSnapshot(entry, ms, this.slowSnapshotMs)) {
      this.options.log.info(
        { url: entry.page.url(), snapshotMs: ms, thresholdMs: this.slowSnapshotMs },
        "Muse tab marked slow; will reload before next turn",
      );
    }
  }

  /** Best-effort: a failed reload only logs, since the turn navigates to its conversation anyway. */
  private async reloadIfSlow(entry: PooledPage): Promise<void> {
    const reload = consumeTabReload(entry);
    if (!reload.shouldReload) return;
    await reloadSlowPage(entry.page, this.options.log, reload.slowSnapshotMs).catch((err: unknown) => {
      this.options.log.warn({ err: err instanceof Error ? err.message : String(err) }, "Slow tab reload failed; continuing");
    });
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.pool.splice(0);
    if (context) {
      await context.close().catch(() => undefined);
    }
  }
}
