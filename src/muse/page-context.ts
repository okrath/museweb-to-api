import type { Logger } from "pino";
import type { Locator, Page } from "playwright";
import type { GatewayConfig } from "../config.js";
import type { TurnEvent } from "../core/types.js";
import { visibleActionLabelsScript, type PageSnapshot } from "./page-scripts.js";
import { isSignedInUrl, selectors, signedOutButtonPattern } from "./selectors.js";

/** Shared by every module that drives the muse.ai page: errors, context and small helpers. */
export const POLL_MS = 250;
const COMPOSER_WAIT_MS = 25_000;
/** Let the app hydrate before a missing composer plus a Log in button counts as signed out. */
const SIGNED_OUT_GRACE_MS = 3_000;

export type TurnErrorKind = Extract<TurnEvent, { type: "error" }>["kind"];

export class TurnError extends Error {
  constructor(
    readonly kind: TurnErrorKind,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "TurnError";
  }
}

export interface TurnTraceEntry {
  at: number;
  stage: string;
  note?: string;
  snapshot?: PageSnapshot;
}

export type TurnTrace = (entry: TurnTraceEntry) => void;

export interface DriverContext {
  config: Pick<GatewayConfig, "museUrl" | "requestTimeoutSec" | "stallTimeoutSec">;
  log: Pick<Logger, "debug" | "info" | "warn" | "error">;
  /** Whether another gateway tab has this conversation open; such a thread is never a new one. */
  openElsewhere?: (page: Page, conversationId: string) => boolean;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

export async function firstVisible(page: Page, list: string[]): Promise<Locator | undefined> {
  for (const selector of list) {
    const candidates = page.locator(selector).filter({ visible: true });
    if ((await candidates.count().catch(() => 0)) > 0) return candidates.last();
  }
  return undefined;
}

/** Like `firstVisible` but does not require visibility; file inputs are commonly hidden. */
export async function firstExisting(page: Page, list: string[]): Promise<Locator | undefined> {
  for (const selector of list) {
    const candidates = page.locator(selector);
    if ((await candidates.count().catch(() => 0)) > 0) return candidates.last();
  }
  return undefined;
}

async function looksSignedOut(page: Page): Promise<boolean> {
  const labels = await page.evaluate(visibleActionLabelsScript).catch(() => [] as string[]);
  return labels.some((label) => signedOutButtonPattern.test(label));
}

export async function waitForComposer(page: Page, museUrl: string, timeoutMs = COMPOSER_WAIT_MS): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  const signedOutCheckAfter = Date.now() + SIGNED_OUT_GRACE_MS;
  while (true) {
    const url = page.url();
    if (!isSignedInUrl(url, museUrl)) {
      throw new TurnError("auth", `Muse session is not signed in (browser landed on ${new URL(url).hostname}). Run "pnpm muse:login".`);
    }
    const composer = await firstVisible(page, selectors.composer);
    if (composer) return composer;
    if (Date.now() >= signedOutCheckAfter && (await looksSignedOut(page))) {
      throw new TurnError("auth", "Muse session is not signed in (landing page with a Log in button). Run \"pnpm muse:login\".");
    }
    if (Date.now() >= deadline) {
      throw new TurnError("browser", "Muse composer not found on the page; run \"pnpm muse:probe\" and update src/muse/selectors.ts");
    }
    await sleep(POLL_MS);
  }
}

export function toTurnError(err: unknown): TurnError {
  if (err instanceof TurnError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/Target (page|context|browser) has been closed|browser has been closed|Target closed/i.test(message)) {
    return new TurnError("browser", `Muse browser tab closed: ${message}`);
  }
  if (/Timeout \d+ms exceeded/i.test(message)) return new TurnError("timeout", message);
  return new TurnError("browser", message);
}
