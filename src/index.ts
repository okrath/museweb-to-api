#!/usr/bin/env node
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import pino from "pino";
import { apiKeyFilePath, resolveApiKey } from "./auth/api-key.js";
import { ResponseCache } from "./cache/response-cache.js";
import { loadConfig, repoRoot, type GatewayConfig } from "./config.js";
import { runLogin } from "./muse/login.js";
import { createMuseDriver } from "./muse/page-driver.js";
import { runProbe } from "./muse/probe.js";
import { buildServer } from "./server.js";
import { SessionStore } from "./sessions/session-store.js";

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
  probe [--send "text"] [--attach path] [--headed]
                   dump the live muse.ai DOM (and one traced turn) to DATA_DIR for selector
                   calibration; repeat --attach to send more than one file with --send
`);
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
