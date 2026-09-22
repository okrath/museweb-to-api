import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Logger } from "pino";
import type { Page, Request, WebSocket } from "playwright";
import type { GatewayConfig } from "../config.js";
import type { TurnEvent } from "../core/types.js";
import { MuseBrowser } from "./browser.js";
import { createMuseDriver, waitForComposer, type TurnTraceEntry } from "./page-driver.js";
import { isSignedInUrl, selectors } from "./selectors.js";

export interface ProbeOptions {
  /** Prompt to send through the real turn pipeline; omit to only inventory the DOM. */
  send?: string;
  headed: boolean;
}

interface NetworkEntry {
  at: number;
  method: string;
  url: string;
  resourceType: string;
  friendlyName?: string;
  postDataHead?: string;
}

interface SocketEntry {
  at: number;
  url: string;
  frames: Array<{ at: number; direction: "sent" | "received"; head: string }>;
  closed?: number;
}

const NOISE = /monitoring|analytics|googlesyndication|consent|client-ip/;
const MAX_FRAMES_PER_SOCKET = 60;
const SCREENSHOT_EVERY_MS = 5_000;

function trackNetwork(request: Request, into: NetworkEntry[]): void {
  const type = request.resourceType();
  if (!["xhr", "fetch", "eventsource", "other"].includes(type)) return;
  const url = request.url();
  if (!/muse|meta|graph|facebook|fb/i.test(url) || NOISE.test(url)) return;
  const entry: NetworkEntry = { at: Date.now(), method: request.method(), url: url.slice(0, 300), resourceType: type };
  const friendly = request.headers()["x-fb-friendly-name"];
  if (friendly) entry.friendlyName = friendly;
  const post = request.postData();
  if (post) entry.postDataHead = post.slice(0, 600);
  into.push(entry);
}

function trackSocket(socket: WebSocket, into: SocketEntry[]): void {
  const entry: SocketEntry = { at: Date.now(), url: socket.url().slice(0, 300), frames: [] };
  into.push(entry);
  const record = (direction: "sent" | "received") => (frame: { payload: string | Buffer }) => {
    if (entry.frames.length >= MAX_FRAMES_PER_SOCKET) return;
    const payload = typeof frame.payload === "string" ? frame.payload : `<binary ${frame.payload.length} bytes>`;
    entry.frames.push({ at: Date.now(), direction, head: payload.slice(0, 500) });
  };
  socket.on("framesent", record("sent"));
  socket.on("framereceived", record("received"));
  socket.on("close", () => {
    entry.closed = Date.now();
  });
}

/**
 * Calibration aid: dumps what the live page exposes (composer candidates, buttons, transcript
 * roots) and, with a prompt, records every stage of a real turn: DOM snapshots, screenshots,
 * fetch calls and WebSocket frames. Everything lands in one folder under DATA_DIR.
 */
export async function runProbe(config: GatewayConfig, log: Logger, options: ProbeOptions): Promise<string> {
  const browser = new MuseBrowser({
    profileDir: `${config.dataDir}/browser-profile`,
    headless: options.headed ? false : config.headless,
    channel: config.browserChannel,
    maxPages: 1,
    log,
  });
  const driver = createMuseDriver({ config, log, browser });
  const network: NetworkEntry[] = [];
  const sockets: SocketEntry[] = [];
  const consoleErrors: string[] = [];
  const trace: TurnTraceEntry[] = [];
  const events: TurnEvent[] = [];
  const screenshots: Promise<unknown>[] = [];
  const outDir = resolve(config.dataDir, `probe-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(outDir, { recursive: true });

  const shoot = (page: Page, name: string) => {
    const path = resolve(outDir, `${String(screenshots.length + 1).padStart(2, "0")}-${name}.png`);
    screenshots.push(page.screenshot({ path, fullPage: false }).catch(() => undefined));
  };

  try {
    const page = await browser.acquirePage();
    page.on("request", (request) => trackNetwork(request, network));
    page.on("websocket", (socket) => trackSocket(socket, sockets));
    page.on("console", (message) => {
      if (message.type() === "error" && consoleErrors.length < 50) consoleErrors.push(message.text().slice(0, 300));
    });
    await page.goto(config.museUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2_000);

    const signedIn = isSignedInUrl(page.url(), config.museUrl);
    if (!signedIn) log.warn({ url: page.url() }, "Not signed in; run \"pnpm muse:login\" first. Dumping the page anyway.");
    else await waitForComposer(page, config.museUrl).catch((err) => log.warn({ err }, "composer not found"));
    shoot(page, "loaded");

    const report = await driver.domReport(page);
    log.info(
      { url: report.url, composers: report.composers.length, buttons: report.buttons.length, modeLike: report.modeLike.length },
      "DOM inventory collected",
    );

    if (options.send && signedIn) {
      const controller = new AbortController();
      let lastShotAt = 0;
      await driver.runTracedTurn(
        page,
        { requestId: "probe", prompt: options.send, mode: "default", signal: controller.signal },
        (event) => events.push(event),
        (entry) => {
          const previous = trace[trace.length - 1];
          const changed =
            entry.stage !== "poll" ||
            !previous ||
            previous.snapshot?.text !== entry.snapshot?.text ||
            previous.snapshot?.stopVisible !== entry.snapshot?.stopVisible ||
            previous.snapshot?.candidates !== entry.snapshot?.candidates;
          if (changed) trace.push(entry);
          if (entry.stage !== "poll" || entry.at - lastShotAt >= SCREENSHOT_EVERY_MS) {
            lastShotAt = entry.at;
            shoot(page, entry.stage);
          }
        },
      );
      shoot(page, "final");
      const text = events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");
      const error = events.find((e) => e.type === "error");
      log.info(
        { chars: text.length, error: error ? (error as { message: string }).message : undefined, traceEntries: trace.length, sockets: sockets.length },
        "Probe turn finished",
      );
    }

    await Promise.allSettled(screenshots);
    const reportPath = resolve(outDir, "report.json");
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          museUrl: config.museUrl,
          signedIn,
          selectors,
          dom: report,
          turn: options.send ? { prompt: options.send, events, trace } : undefined,
          network,
          sockets,
          consoleErrors,
        },
        null,
        2,
      ),
    );
    log.info({ outDir }, "Probe report written");
    return reportPath;
  } finally {
    await Promise.allSettled(screenshots);
    await browser.close();
  }
}
