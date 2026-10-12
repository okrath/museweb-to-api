import type { Page } from "playwright";
import type { TurnEvent, TurnInput } from "../core/types.js";
import { computeMedian } from "./browser.js";
import { attachFiles, openConversation, selectMode, submit, typePrompt } from "./composer.js";
import { htmlToMarkdown } from "./markdown.js";
import { claimedThreads, ensureThreadPanel, resolveCreatedThread, resolveThreadAfterReply, serialized } from "./new-thread.js";
import { type DriverContext, firstVisible, POLL_MS, sleep, TurnError, type TurnTrace } from "./page-context.js";
import { markSeenScript, promptTailKey, snapshotScript, type PageSnapshot } from "./page-scripts.js";
import { conversationIdFromUrl, deliveryFailurePattern, isSignedInUrl, rateLimitPattern, selectors, upstreamErrorPattern } from "./selectors.js";
import { createReaderState, decide, DeltaStreamer, type ReaderTimings } from "./turn-reader.js";

const RATE_LIMIT_RETRY_SEC = 300;
/** Muse wakes a per-user VM before answering; the first token can take a while. */
const FIRST_TOKEN_TIMEOUT_MS = 180_000;

/** Drives one full turn on an already-acquired tab. Throws TurnError on any failure. */
export async function executeTurn(
  page: Page,
  ctx: DriverContext,
  input: TurnInput,
  emit: (event: TurnEvent) => void,
  trace?: TurnTrace,
): Promise<{ text: string; conversationId?: string; snapshotMs?: number }> {
  const composer = await openConversation(page, ctx, input.conversationId);
  trace?.({ at: Date.now(), stage: "conversation_open", note: page.url() });
  await selectMode(page, input.mode, ctx);

  const cleanupAttachments =
    input.attachments && input.attachments.length > 0 ? await attachFiles(page, input.attachments, ctx) : undefined;
  try {
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
      promptTail: promptTailKey(input.prompt),
    };
    const snapshot = () => page.evaluate(snapshotScript, snapshotArgs);

    const timings: ReaderTimings = {
      stableMs: 1_500,
      stableWithoutStopMs: 4_000,
      firstTokenTimeoutMs: FIRST_TOKEN_TIMEOUT_MS,
      stallTimeoutMs: ctx.config.stallTimeoutSec * 1000,
      hardTimeoutMs: ctx.config.requestTimeoutSec * 1000,
    };

    const finishTurn = (text: string, conversationId: string | undefined, snapshotMs?: number) => {
      if (conversationId) emit({ type: "conversation", conversationId });
      emit({ type: "done", stopReason: "end_turn" });
      trace?.({ at: Date.now(), stage: "done", note: conversationId });
      return { text, conversationId, snapshotMs };
    };

    if (input.conversationId) {
      claimedThreads.add(input.conversationId);
      await typePrompt(page, composer, input.prompt);
      trace?.({ at: Date.now(), stage: "prompt_typed" });
      await submit(page, composer, snapshot, ctx);
      trace?.({ at: Date.now(), stage: "submitted" });
      const reply = await readReply(page, ctx, input, snapshot, emit, timings, trace);
      return finishTurn(reply.text, conversationIdFromUrl(page.url(), ctx.config.museUrl), reply.snapshotMs);
    }

    // The whole new-thread turn is serialized per process: two parallel turns posting into
    // `/thread/new` could otherwise claim each other's panel row.
    return await serialized(async () => {
      const rowsBefore = await ensureThreadPanel(page);
      await typePrompt(page, composer, input.prompt);
      trace?.({ at: Date.now(), stage: "prompt_typed" });
      await submit(page, composer, snapshot, ctx);
      trace?.({ at: Date.now(), stage: "submitted" });
      const where = await resolveCreatedThread(page, ctx, rowsBefore, snapshot, timings.firstTokenTimeoutMs, trace);
      // Claimed before reading, so a reply that fails or times out still never lends this chat to another turn.
      const routed = conversationIdFromUrl(page.url(), ctx.config.museUrl);
      if (routed) claimedThreads.add(routed);
      const reply = await readReply(page, ctx, input, snapshot, emit, timings, trace);
      // Muse sometimes re-routes the draft page to the created thread on its own; only fall back
      // to the panel when the URL still says `/thread/new`.
      const conversationId =
        conversationIdFromUrl(page.url(), ctx.config.museUrl) ??
        (where === "draft" ? await resolveThreadAfterReply(page, ctx, snapshot, trace) : undefined);
      if (conversationId) claimedThreads.add(conversationId);
      return finishTurn(reply.text, conversationId, reply.snapshotMs);
    });
  } finally {
    await cleanupAttachments?.();
  }
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
): Promise<{ text: string; snapshotMs?: number }> {
  const state = createReaderState(Date.now());
  const streamer = new DeltaStreamer();
  let lastHtml = "";
  const snapshotTimes: number[] = [];

  while (true) {
    if (input.signal.aborted) {
      const stop = await firstVisible(page, selectors.stopButton);
      await stop?.click().catch(() => undefined);
      throw new TurnError("browser", "client disconnected during the Muse turn");
    }
    const snapStart = Date.now();
    const snap = await snapshot();
    snapshotTimes.push(Date.now() - snapStart);
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
  const snapshotMs = computeMedian(snapshotTimes);
  return { text: finalMarkdown, snapshotMs };
}
