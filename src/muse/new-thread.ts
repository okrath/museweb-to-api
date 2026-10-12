import type { Page } from "playwright";
import { type DriverContext, firstVisible, POLL_MS, sleep, TurnError, type TurnTrace, waitForComposer } from "./page-context.js";
import { threadRowsScript, type PageSnapshot, type ThreadRow } from "./page-scripts.js";
import { conversationIdFromUrl, mainChatRowPattern, selectors, threadUrlPattern } from "./selectors.js";

/** Finding the side chat a prompt posted into `/thread/new` created. */
/** How long a freshly opened thread may take to render its transcript after the composer. */
const THREAD_RENDER_WAIT_MS = 15_000;
const PANEL_OPEN_WAIT_MS = 6_000;
const THREAD_LOAD_ATTEMPTS = 3;
/** Newest panel rows to try when looking for the thread that holds a freshly posted prompt. */
const THREAD_ROW_CANDIDATES = 3;

/**
 * Side chats this process has created or continued. None of them is ever a thread a new prompt
 * just created, even when it holds an identical prompt (every warm-up sends the same one).
 * A deleted chat leaves the panel, so deleting one drops it from this set.
 */
export const claimedThreads = new Set<string>();

async function threadRows(page: Page): Promise<ThreadRow[]> {
  return page.evaluate(threadRowsScript, { row: selectors.threadRow });
}

/** Makes sure the side-chat panel is open so new threads can be observed and clicked. */
export async function ensureThreadPanel(page: Page): Promise<ThreadRow[]> {
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
  // A thread busy in another tab, or one another turn just finished in, sits at the top of the
  // panel exactly like a new one. Claiming it cut that tab's reply short, filed a used
  // conversation as a clean warm thread, and handed one subagent another's reply (seen live
  // 2026-10-12, the last after the other tab had already moved on).
  if (claimedThreads.has(landed) || ctx.openElsewhere?.(page, landed)) {
    trace?.({ at: Date.now(), stage: "thread_skipped", note: `${landed} belongs to another turn` });
    return undefined;
  }
  for (let attempt = 0; attempt < THREAD_LOAD_ATTEMPTS; attempt++) {
    if (attempt > 0) await page.goto(landed, { waitUntil: "domcontentloaded" });
    await waitForComposer(page, ctx.config.museUrl);
    const renderDeadline = Date.now() + THREAD_RENDER_WAIT_MS;
    let snap = await snapshot();
    while (!snap.promptEchoed && snap.candidates === 0 && Date.now() < renderDeadline) {
      await sleep(POLL_MS);
      snap = await snapshot();
    }
    trace?.({ at: Date.now(), stage: "thread_opened", note: `${page.url()} attempt=${attempt + 1}`, snapshot: snap });
    // Every message is unseen in a freshly opened thread, so `promptPosted` would accept any of
    // them; only a message that holds this prompt's head and tail proves the thread is ours.
    if (snap.promptEchoed) {
      claimedThreads.add(landed);
      return landed;
    }
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
export async function resolveCreatedThread(
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
export async function resolveThreadAfterReply(
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
export function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = newThreadQueue.then(task, task);
  newThreadQueue = run.catch(() => undefined);
  return run;
}
