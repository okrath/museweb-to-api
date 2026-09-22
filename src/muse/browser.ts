import type { Logger } from "pino";
import { chromium, type BrowserContext, type Page } from "playwright";

export interface MuseBrowserOptions {
  profileDir: string;
  headless: boolean;
  channel?: string;
  maxPages: number;
  log: Pick<Logger, "info" | "warn" | "error" | "debug">;
}

interface PooledPage {
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

  constructor(private readonly options: MuseBrowserOptions) {}

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
        return entry.page;
      }
    }
    this.pool.splice(0, this.pool.length, ...this.pool.filter((entry) => !entry.page.isClosed()));
    if (this.pool.length >= this.options.maxPages) {
      throw new Error("no free browser tab (turn slots and tab pool are out of sync)");
    }
    const page = context.pages().find((p) => !this.pool.some((entry) => entry.page === p)) ?? (await context.newPage());
    this.pool.push({ page, busy: true });
    return page;
  }

  releasePage(page: Page): void {
    const entry = this.pool.find((candidate) => candidate.page === page);
    if (entry) entry.busy = false;
  }

  /** Tabs currently parked on a given URL, so a resumed conversation can skip navigation. */
  idlePageAt(url: string): Page | undefined {
    return this.pool.find((entry) => !entry.busy && !entry.page.isClosed() && entry.page.url().startsWith(url))?.page;
  }

  markBusy(page: Page): boolean {
    const entry = this.pool.find((candidate) => candidate.page === page);
    if (!entry || entry.busy) return false;
    entry.busy = true;
    return true;
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
