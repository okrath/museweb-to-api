#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "playwright";
import pino from "pino";
import { apiKeyFilePath, resolveApiKey } from "./auth/api-key.js";
import { ResponseCache } from "./cache/response-cache.js";
import { loadConfig, repoRoot, type GatewayConfig } from "./config.js";
import { runLogin } from "./muse/login.js";
import { MuseBrowser } from "./muse/browser.js";
import { createMuseDriver, waitForComposer } from "./muse/page-driver.js";
import { runProbe } from "./muse/probe.js";
import { deleteAllSideThreads } from "./muse/thread-cleanup.js";
import { buildServer } from "./server.js";
import { SessionStore } from "./sessions/session-store.js";
import { JsonStore } from "./store/json-store.js";
const SWEEP_INTERVAL_MS = 60 * 60_000;

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function createLogger(config: GatewayConfig): pino.Logger {
  return pino({
    level: config.logLevel,
    transport: process.env.NODE_ENV === "production" ? undefined : { target: "pino-pretty", options: { colorize: true } },
  });
}

async function serve(config: GatewayConfig): Promise<void> {
  mkdirSync(config.dataDir, { recursive: true });
  const log = createLogger(config);
  const { key, source } = resolveApiKey(config.dataDir, config.apiKey);
  if (source === "generated") log.warn({ path: apiKeyFilePath(config.dataDir) }, "Generated a client API key");
  else log.info({ source }, "Client API key loaded");

  const sessions = new SessionStore(resolve(config.dataDir, "sessions.json"));
  const cache = new ResponseCache(resolve(config.dataDir, "response-cache.json"));
  const driver = createMuseDriver({ config, log });
  const app = await buildServer({ config, apiKey: key, driver, sessions, cache, version: readVersion(), logger: log });

  const sweep = () => {
    const now = Date.now();
    const removedSessions = sessions.pruneExpired(now);
    const removedCache = cache.pruneExpired(now);
    if (removedSessions + removedCache > 0) log.debug({ removedSessions, removedCache }, "Expired entries pruned");
  };
  sweep();
  const sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  await app.listen({ port: config.port, host: config.host });
  log.info(
    {
      url: `http://${config.host}:${config.port}/v1`,
      sessionTtlSec: config.sessionTtlSec,
      cacheTtlSec: config.cacheTtlSec,
      warmThreads: config.warmThreads,
    },
    "museweb-to-api is listening",
  );

  // Launch the browser now so a missing sign-in shows up in the logs before the first request.
  driver.browser.getContext().catch((err: unknown) => log.error({ err }, "Muse browser failed to launch"));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(sweepTimer);
    log.info({ signal }, "Shutting down");
    await app.close().catch((err: unknown) => log.error({ err }, "Error closing server"));
    await driver.close().catch((err: unknown) => log.error({ err }, "Error closing browser"));
    sessions.flush();
    cache.flush();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function parseProbeArgs(args: string[]): { send?: string; attach?: string[]; headed: boolean } {
  let send: string | undefined;
  let attach: string[] | undefined;
  let headed = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--send") send = args[++i];
    else if (arg.startsWith("--send=")) send = arg.slice("--send=".length);
    else if (arg === "--attach") (attach ??= []).push(args[++i]!);
    else if (arg.startsWith("--attach=")) (attach ??= []).push(arg.slice("--attach=".length));
    else if (arg === "--headed") headed = true;
  }
  return { send, attach, headed };
}

function usage(): void {
  console.log(`museweb-to-api <command>

  serve            start the OpenAI/Anthropic-compatible gateway (default)
  login            open a browser window to sign in to Muse once
  clean-threads    delete all Muse side-chat threads and reset local sessions
  probe [--send "text"] [--attach path] [--headed]
                   dump the live muse.ai DOM (and one traced turn) to DATA_DIR for selector
                   calibration; repeat --attach to send more than one file with --send
`);
}

async function runCleanThreads(config: GatewayConfig, log: pino.Logger): Promise<void> {
  const serverUrl = `http://${config.host}:${config.port}`;
  let serverRunning = false;
  try {
    const res = await fetch(`${serverUrl}/healthz`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) serverRunning = true;
  } catch {
    serverRunning = false;
  }

  if (serverRunning) {
    log.info({ serverUrl }, "Gateway server is running; sending clean-threads request to gateway API");
    const { key } = resolveApiKey(config.dataDir, config.apiKey);
    const res = await fetch(`${serverUrl}/v1/clean-threads`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Server returned error ${res.status}: ${text}`);
    }
    const data = (await res.json()) as { ok: boolean; deleted: number; titles: string[] };
    log.info({ deleted: data.deleted }, "Cleaned Muse threads via gateway API");
    console.log(`Deleted ${data.deleted} threads:`);
    for (const title of data.titles) {
      console.log(`  - ${title}`);
    }
    return;
  }

  log.info("Gateway server is not running; launching browser directly");
  const browser = new MuseBrowser({
    profileDir: `${config.dataDir}/browser-profile`,
    headless: config.headless,
    channel: config.browserChannel,
    maxPages: 1,
    log,
  });

  const sessions = new SessionStore(resolve(config.dataDir, "sessions.json"));
  const cache = new ResponseCache(resolve(config.dataDir, "response-cache.json"));
  const warmPath = resolve(config.dataDir, "warm-threads.json");
  const warmStore = existsSync(warmPath) ? new JsonStore<unknown>(warmPath) : undefined;

  let page: Page | undefined;
  try {
    page = await browser.acquirePage();
    await page.goto(config.museUrl, { waitUntil: "domcontentloaded" });
    await waitForComposer(page, config.museUrl, 15_000).catch(() => undefined);
    const result = await deleteAllSideThreads(page, (p) => {
      console.log(`Deleted (${p.deleted}/${p.totalKnown}): "${p.title}"`);
    });

    sessions.clear();
    cache.clear();
    if (warmStore) {
      warmStore.prune(() => false);
      warmStore.flush();
    }

    log.info({ deleted: result.deleted }, "Deleted Muse threads directly");
    console.log(`Finished deleting ${result.deleted} threads.`);
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const [command = "serve", ...rest] = process.argv.slice(2);
  if (command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }
  const config = loadConfig();
  if (command === "serve") {
    await serve(config);
    return;
  }
  const log = createLogger(config);
  if (command === "login") {
    await runLogin(config, log);
    return;
  }
  if (command === "clean-threads" || command === "clean") {
    await runCleanThreads(config, log);
    return;
  }
  if (command === "probe") {
    await runProbe(config, log, parseProbeArgs(rest));
    return;
  }
  usage();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
