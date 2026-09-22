import type { Logger } from "pino";
import type { Locator, Page } from "playwright";
import type { GatewayConfig } from "../config.js";
import type { DriverStatus, MuseDriver, MuseMode, TurnEvent, TurnInput } from "../core/types.js";
import { MuseBrowser } from "./browser.js";
import { htmlToMarkdown } from "./markdown.js";
import {
  domReportScript,
  markSeenScript,
  snapshotScript,
  threadRowsScript,
  visibleActionLabelsScript,
  type DomReport,
  type PageSnapshot,
  type ThreadRow,
} from "./page-scripts.js";
import {
  conversationIdFromUrl,
  deliveryFailurePattern,
  isSignedInUrl,
  mainChatRowPattern,
  modeLabels,
  newChatUrl,
  rateLimitPattern,
  selectors,
  signedOutButtonPattern,
  threadUrlPattern,
  upstreamErrorPattern,
} from "./selectors.js";
import { enforceThreadCap } from "./thread-cleanup.js";
import { createReaderState, decide, DeltaStreamer, type ReaderTimings } from "./turn-reader.js";

const POLL_MS = 250;
const COMPOSER_WAIT_MS = 25_000;
const SUBMIT_CONFIRM_MS = 8_000;
const MODE_OPTION_WAIT_MS = 1_500;
/** Let the app hydrate before a missing composer plus a Log in button counts as signed out. */
const SIGNED_OUT_GRACE_MS = 3_000;
const RATE_LIMIT_RETRY_SEC = 300;
/** Muse wakes a per-user VM before answering; the first token can take a while. */
const FIRST_TOKEN_TIMEOUT_MS = 180_000;
/** How long a freshly opened thread may take to render its transcript after the composer. */
const THREAD_RENDER_WAIT_MS = 15_000;
const PANEL_OPEN_WAIT_MS = 6_000;
const THREAD_LOAD_ATTEMPTS = 3;
/** Newest panel rows to try when looking for the thread that holds a freshly posted prompt. */
const THREAD_ROW_CANDIDATES = 3;

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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

async function firstVisible(page: Page, list: string[]): Promise<Locator | undefined> {
  for (const selector of list) {
    const candidates = page.locator(selector).filter({ visible: true });
    if ((await candidates.count().catch(() => 0)) > 0) return candidates.last();
  }
  return undefined;
}

async function composerText(composer: Locator): Promise<string> {
  return composer.evaluate((el) => {
    const input = el as HTMLTextAreaElement;
    return typeof input.value === "string" ? input.value : ((el as HTMLElement).innerText ?? el.textContent ?? "");
  });
}

function acceptedPrompt(observed: string, prompt: string): boolean {
  const seen = normalizeText(observed);
  const want = normalizeText(prompt);
  if (seen === want) return true;
  if (want.length === 0) return seen.length === 0;
  const ratio = seen.length / want.length;
  return ratio >= 0.98 && ratio <= 1.02 && seen.slice(0, 40) === want.slice(0, 40);
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

async function openConversation(page: Page, ctx: DriverContext, conversationId: string | undefined): Promise<Locator> {
  // A new API conversation always gets its own Muse side chat, never the user's main chat.
  const target = conversationId ?? newChatUrl(ctx.config.museUrl);
  if (!conversationId || !sameUrl(page.url(), target)) {
    await page.goto(target, { waitUntil: "domcontentloaded" });
  }
  const composer = await waitForComposer(page, ctx.config.museUrl);
  if (conversationId) {
    const landed = conversationIdFromUrl(page.url(), ctx.config.museUrl);
    if (!landed || !sameUrl(landed, conversationId)) {
      throw new TurnError("browser", `Muse conversation ${conversationId} is no longer reachable (page is at ${page.url()})`);
    }
  }
  return composer;
}

async function labelOf(locator: Locator): Promise<string> {
  return locator.evaluate((el) => `${(el as HTMLElement).innerText ?? ""} ${el.getAttribute("aria-label") ?? ""}`);
}

async function selectMode(page: Page, mode: MuseMode, ctx: DriverContext): Promise<void> {
  if (mode === "default") return;
  const wanted = modeLabels[mode];
  const anyMode = /instant|thinking|contemplat/i;

  const buttons: Locator[] = [];
  for (const selector of selectors.modeMenuButton) {
    const matches = page.locator(selector).filter({ visible: true });
    const count = await matches.count().catch(() => 0);
    for (let i = 0; i < count && buttons.length < 8; i++) buttons.push(matches.nth(i));
  }
  const labelled = await Promise.all(buttons.map(async (button) => ({ button, label: await labelOf(button).catch(() => "") })));
  labelled.sort((a, b) => Number(anyMode.test(b.label)) - Number(anyMode.test(a.label)));

  for (const { button, label } of labelled.slice(0, 6)) {
    if (wanted.test(label)) return;
    await button.click().catch(() => undefined);
    const option = page.locator(selectors.modeOption.join(","), { hasText: wanted }).filter({ visible: true }).first();
    const found = await option.waitFor({ state: "visible", timeout: MODE_OPTION_WAIT_MS }).then(() => true, () => false);
    if (found) {
      await option.click();
      await sleep(300);
      ctx.log.debug({ mode }, "Muse mode selected");
      return;
    }
    await page.keyboard.press("Escape").catch(() => undefined);
  }
  throw new TurnError(
    "browser",
    `Muse mode "${mode}" could not be selected; run "pnpm muse:probe" and update modeMenuButton/modeOption in src/muse/selectors.ts, or use model "muse"`,
  );
}

async function typePrompt(page: Page, composer: Locator, prompt: string): Promise<void> {
  await composer.click();
  await composer.fill(prompt).catch(() => undefined);
  if (acceptedPrompt(await composerText(composer), prompt)) return;

  await composer.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(prompt);
  const observed = await composerText(composer);
  if (!acceptedPrompt(observed, prompt)) {
    throw new TurnError(
      "browser",
      `Muse composer did not accept the full prompt (expected ${prompt.length} chars, saw ${observed.length})`,
    );
  }
}

async function threadRows(page: Page): Promise<ThreadRow[]> {
  return page.evaluate(threadRowsScript, { row: selectors.threadRow });
}

/** Makes sure the side-chat panel is open so new threads can be observed and clicked. */
async function ensureThreadPanel(page: Page): Promise<ThreadRow[]> {
  // The panel populates a moment after the composer; only click the trigger when it is
  // actually collapsed (the trigger button is visible), otherwise just wait for the rows.
  const deadline = Date.now() + PANEL_OPEN_WAIT_MS;
  let clicked = false;
  let rows = await threadRows(page);
  while (!rows.some((row) => row.visible) && Date.now() < deadline) {
    if (!clicked) {
      const trigger = await firstVisible(page, selectors.threadPanelTrigger);
      if (trigger) {
        await trigger.click().catch(() => undefined);
        clicked = true;
      }
    }
    await sleep(POLL_MS);
    rows = await threadRows(page);
  }
  if (!rows.some((row) => row.visible)) {
    throw new TurnError("browser", "Muse side-chat panel not found; run \"pnpm muse:probe\" and update threadPanel/threadRow in src/muse/selectors.ts");
  }
  return rows;
}

/**
 * `/thread/new` posts the message into a brand-new side chat but keeps showing the draft page,
 * so the reply never renders there. Wait for the new row to appear in the panel, open it, and
 * verify it really holds our prompt before reading the reply from that thread.
 */
function sideRowsOf(rows: ThreadRow[]): ThreadRow[] {
  return rows.filter((row) => !mainChatRowPattern.test(row.text));
}

/**
 * Opens one panel row and reports whether that thread holds the posted prompt. The composer
 * renders before the transcript, and a thread opened right after creation sometimes shows
 * "Something went wrong"; reloading the thread URL recovers it.
 */
async function openRowWithPrompt(
  page: Page,
  ctx: DriverContext,
  row: ThreadRow,
  snapshot: () => Promise<PageSnapshot>,
  trace?: TurnTrace,
): Promise<string | undefined> {
  await page.locator(selectors.threadRow.join(",")).nth(row.index).click();
  await page.waitForURL((url) => threadUrlPattern.test(url.pathname), { timeout: 10_000 }).catch(() => undefined);
  const landed = conversationIdFromUrl(page.url(), ctx.config.museUrl);
  if (!landed) return undefined;
  for (let attempt = 0; attempt < THREAD_LOAD_ATTEMPTS; attempt++) {
    if (attempt > 0) await page.goto(landed, { waitUntil: "domcontentloaded" });
    await waitForComposer(page, ctx.config.museUrl);
    const renderDeadline = Date.now() + THREAD_RENDER_WAIT_MS;
    let snap = await snapshot();
    while (!snap.promptPosted && snap.candidates === 0 && Date.now() < renderDeadline) {
      await sleep(POLL_MS);
      snap = await snapshot();
    }
    trace?.({ at: Date.now(), stage: "thread_opened", note: `${page.url()} attempt=${attempt + 1}`, snapshot: snap });
    if (snap.promptPosted) return landed;
    // A transcript that rendered other messages but not ours is simply the wrong thread.
    if (snap.candidates > 0 || snap.freshRoots > 0) return undefined;
  }
  return undefined;
}

/**
 * `/thread/new` posts the message into a brand-new side chat but keeps its own URL. The panel is
 * a virtualised list, so a new thread shows up as a changed top row rather than a longer list;
 * click the candidate rows (newest first) until one holds the posted prompt. If Muse renders the
 * reply on the draft page first, read it there and resolve the thread afterwards.
 */
async function resolveCreatedThread(
  page: Page,
  ctx: DriverContext,
  rowsBefore: ThreadRow[],
  snapshot: () => Promise<PageSnapshot>,
  timeoutMs: number,
  trace?: TurnTrace,
): Promise<"thread" | "draft"> {
  const deadline = Date.now() + timeoutMs;
  const before = sideRowsOf(rowsBefore);
  let knownCount = before.length;
  let knownTop = before[0]?.text;
  while (Date.now() < deadline) {
    const sideRows = sideRowsOf(await threadRows(page)).filter((row) => row.visible);
    const changed = sideRows.length > knownCount || (sideRows.length > 0 && sideRows[0]!.text !== knownTop);
    if (changed) {
      for (const row of sideRows.slice(0, THREAD_ROW_CANDIDATES)) {
        if (await openRowWithPrompt(page, ctx, row, snapshot, trace)) return "thread";
      }
      const current = sideRowsOf(await threadRows(page)).filter((row) => row.visible);
      knownCount = current.length;
      knownTop = current[0]?.text;
    } else {
      const snap = await snapshot();
      if (snap.promptPosted && snap.candidates > 0) {
        trace?.({ at: Date.now(), stage: "reply_on_draft", note: page.url(), snapshot: snap });
        return "draft";
      }
    }
    await sleep(POLL_MS * 2);
  }
  throw new TurnError("timeout", "Muse did not create a side chat for the posted message in time (the agent VM may be unreachable)");
}

/** After reading a reply on the draft page, find the thread that now holds the prompt. */
async function resolveThreadAfterReply(
  page: Page,
  ctx: DriverContext,
  snapshot: () => Promise<PageSnapshot>,
  trace?: TurnTrace,
): Promise<string | undefined> {
  const sideRows = sideRowsOf(await threadRows(page)).filter((row) => row.visible);
  for (const row of sideRows.slice(0, THREAD_ROW_CANDIDATES)) {
    const landed = await openRowWithPrompt(page, ctx, row, snapshot, trace).catch(() => undefined);
    if (landed) return landed;
  }
  ctx.log.warn("Muse answered on the draft page but the new side chat could not be identified; the conversation will not be resumable");
  return undefined;
}

/** New side chats are resolved one at a time so two parallel turns cannot claim each other's row. */
let newThreadQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = newThreadQueue.then(task, task);
  newThreadQueue = run.catch(() => undefined);
  return run;
}

async function submit(page: Page, composer: Locator, snapshot: () => Promise<PageSnapshot>, ctx: DriverContext): Promise<void> {
  const send = await firstVisible(page, selectors.sendButton);
  const enabled = send ? await send.isEnabled().catch(() => false) : false;
  if (send && enabled) await send.click();
  else await composer.press("Enter");

  const deadline = Date.now() + SUBMIT_CONFIRM_MS;
  while (Date.now() < deadline) {
    const snap = await snapshot();
    if (snap.stopVisible || snap.candidates > 0 || normalizeText(snap.composerText).length === 0) return;
    await sleep(POLL_MS);
  }
  ctx.log.warn("Muse composer still holds the prompt after sending; waiting for a reply anyway");
}

/** Drives one full turn on an already-acquired tab. Throws TurnError on any failure. */
export async function executeTurn(
  page: Page,
  ctx: DriverContext,
  input: TurnInput,
  emit: (event: TurnEvent) => void,
  trace?: TurnTrace,
): Promise<{ text: string; conversationId?: string }> {
  const composer = await openConversation(page, ctx, input.conversationId);
  trace?.({ at: Date.now(), stage: "conversation_open", note: page.url() });
  await selectMode(page, input.mode, ctx);

  await page.evaluate(markSeenScript, { root: selectors.conversationRoot });
  const snapshotArgs = {
    root: selectors.conversationRoot,
    stop: selectors.stopButton,
    composer: selectors.composer,
    assistant: selectors.assistantMessage,
    user: selectors.userMessage,
    strip: selectors.strip,
    alerts: selectors.alerts,
    ignore: selectors.ignore,
    promptHead: input.prompt.slice(0, 120),
  };
  const snapshot = () => page.evaluate(snapshotScript, snapshotArgs);

  const timings: ReaderTimings = {
    stableMs: 1_500,
    stableWithoutStopMs: 4_000,
    firstTokenTimeoutMs: FIRST_TOKEN_TIMEOUT_MS,
    stallTimeoutMs: ctx.config.stallTimeoutSec * 1000,
    hardTimeoutMs: ctx.config.requestTimeoutSec * 1000,
  };

  const finishTurn = (text: string, conversationId: string | undefined) => {
    if (conversationId) emit({ type: "conversation", conversationId });
    emit({ type: "done", stopReason: "end_turn" });
    trace?.({ at: Date.now(), stage: "done", note: conversationId });
    return { text, conversationId };
  };

  if (input.conversationId) {
    await typePrompt(page, composer, input.prompt);
    trace?.({ at: Date.now(), stage: "prompt_typed" });
    await submit(page, composer, snapshot, ctx);
    trace?.({ at: Date.now(), stage: "submitted" });
    const text = await readReply(page, ctx, input, snapshot, emit, timings, trace);
    return finishTurn(text, conversationIdFromUrl(page.url(), ctx.config.museUrl));
  }

  // The whole new-thread turn is serialized per process: two parallel turns posting into
  // `/thread/new` could otherwise claim each other's panel row.
  return serialized(async () => {
    const rowsBefore = await ensureThreadPanel(page);
    await typePrompt(page, composer, input.prompt);
    trace?.({ at: Date.now(), stage: "prompt_typed" });
    await submit(page, composer, snapshot, ctx);
    trace?.({ at: Date.now(), stage: "submitted" });
    const where = await resolveCreatedThread(page, ctx, rowsBefore, snapshot, timings.firstTokenTimeoutMs, trace);
    const text = await readReply(page, ctx, input, snapshot, emit, timings, trace);
    // Muse sometimes re-routes the draft page to the created thread on its own; only fall back
    // to the panel when the URL still says `/thread/new`.
    const conversationId =
      conversationIdFromUrl(page.url(), ctx.config.museUrl) ??
      (where === "draft" ? await resolveThreadAfterReply(page, ctx, snapshot, trace) : undefined);
    const result = finishTurn(text, conversationId);
    await enforceThreadCap(page, ctx);
    return result;
  });
}

/** Polls the transcript until the reply is complete, streaming finished paragraphs as it grows. */
async function readReply(
  page: Page,
  ctx: DriverContext,
  input: TurnInput,
  snapshot: () => Promise<PageSnapshot>,
  emit: (event: TurnEvent) => void,
  timings: ReaderTimings,
  trace?: TurnTrace,
): Promise<string> {
  const state = createReaderState(Date.now());
  const streamer = new DeltaStreamer();
  let lastHtml = "";

  while (true) {
    if (input.signal.aborted) {
      const stop = await firstVisible(page, selectors.stopButton);
      await stop?.click().catch(() => undefined);
      throw new TurnError("browser", "client disconnected during the Muse turn");
    }
    const snap = await snapshot();
    trace?.({ at: Date.now(), stage: "poll", snapshot: snap });
    if (!isSignedInUrl(snap.url, ctx.config.museUrl)) {
      throw new TurnError("auth", "Muse signed the browser out during the turn; run \"pnpm muse:login\"");
    }
    const alertText = snap.alerts.join(" | ");
    if (alertText && rateLimitPattern.test(alertText)) {
      throw new TurnError("rate_limit", `Muse reported a usage limit: ${alertText}`, RATE_LIMIT_RETRY_SEC);
    }
    if (alertText && !snap.stopVisible && state.lastText.length === 0 && upstreamErrorPattern.test(alertText)) {
      throw new TurnError("browser", `Muse reported an error before answering: ${alertText}`);
    }

    const decision = decide(state, { text: snap.text, stopVisible: snap.stopVisible }, Date.now(), timings);
    if (snap.html !== lastHtml) {
      lastHtml = snap.html;
      const delta = streamer.push(htmlToMarkdown(snap.html));
      if (delta) emit({ type: "text_delta", text: delta });
    }
    if (decision.kind === "done") break;
    if (decision.kind === "timeout") {
      const reason =
        decision.reason === "no_reply"
          ? "Muse did not start answering in time"
          : decision.reason === "stalled"
            ? "Muse stopped updating its reply"
            : "Muse turn exceeded the request timeout";
      const detail = [
        snap.promptPosted ? undefined : "the prompt never appeared in the transcript",
        deliveryFailurePattern.test(snap.deliveryStatus) ? `Muse reported "${snap.deliveryStatus}"` : undefined,
        alertText ? `page said: ${alertText.slice(0, 200)}` : undefined,
      ].filter(Boolean);
      throw new TurnError("timeout", detail.length > 0 ? `${reason} (${detail.join("; ")})` : reason);
    }
    await sleep(POLL_MS);
  }

  const finalMarkdown = htmlToMarkdown(lastHtml);
  const tail = streamer.finish(finalMarkdown);
  if (tail.length > 0) emit({ type: "text_delta", text: tail });
  if (streamer.diverged) {
    ctx.log.warn({ requestId: input.requestId }, "Muse rewrote already-streamed Markdown; the client received the final text after the divergence point");
  }
  if (finalMarkdown.length === 0) {
    throw new TurnError("browser", "Muse reply node was detected but converted to empty text");
  }
  return finalMarkdown;
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
      log,
    });
  const ctx: DriverContext = { config, log };

  async function acquire(conversationId: string | undefined): Promise<Page> {
    if (conversationId) {
      const parked = browser.idlePageAt(conversationId);
      if (parked && browser.markBusy(parked)) return parked;
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
        log.info(
          { requestId: input.requestId, mode: input.mode, resumed: Boolean(input.conversationId), chars: result.text.length, ms: Date.now() - startedAt },
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
    async domReport(page) {
      return page.evaluate(domReportScript, {
        composer: selectors.composer,
        root: selectors.conversationRoot,
        assistant: selectors.assistantMessage,
        user: selectors.userMessage,
      });
    },
    async status(): Promise<DriverStatus> {
      return { browserOpen: browser.isOpen, activeTurns: browser.busyCount, maxConcurrentTurns: config.maxConcurrentTurns };
    },
    async close() {
      await browser.close();
    },
  };
}
