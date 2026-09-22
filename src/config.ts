import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

export const repoRoot = resolve(import.meta.dirname, "..");
const defaultEnvPath = resolve(repoRoot, ".env");

const boolish = z
  .string()
  .optional()
  .transform((value) => {
    if (value === undefined || value === "") return undefined;
    return !["0", "false", "no", "off"].includes(value.toLowerCase());
  });

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value && value.length > 0 ? value : undefined));

const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8090),
  HOST: z.string().default("127.0.0.1"),
  DATA_DIR: z.string().default("./data"),
  API_KEY: optionalString,
  MUSE_URL: z.string().url().default("https://muse.ai/"),
  HEADLESS: boolish,
  BROWSER_CHANNEL: optionalString,
  MAX_CONCURRENT_TURNS: z.coerce.number().int().min(1).max(8).default(2),
  WARM_THREADS: z.coerce.number().int().min(0).default(1),
  QUEUE_TIMEOUT_SEC: z.coerce.number().int().min(1).default(30),
  REQUEST_TIMEOUT_SEC: z.coerce.number().int().min(10).default(900),
  STALL_TIMEOUT_SEC: z.coerce.number().int().min(5).default(180),
  SESSION_TTL_SEC: z.coerce.number().int().min(0).default(86_400),
  CACHE_TTL_SEC: z.coerce.number().int().min(0).default(300),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export interface GatewayConfig {
  port: number;
  host: string;
  dataDir: string;
  apiKey?: string;
  museUrl: string;
  headless: boolean;
  browserChannel?: string;
  maxConcurrentTurns: number;
  warmThreads: number;
  queueTimeoutSec: number;
  requestTimeoutSec: number;
  stallTimeoutSec: number;
  sessionTtlSec: number;
  cacheTtlSec: number;
  logLevel: string;
}

export function loadConfig(options?: { envFile?: string | false; env?: NodeJS.ProcessEnv }): GatewayConfig {
  const envFile = options?.envFile ?? defaultEnvPath;
  if (envFile !== false && existsSync(envFile)) {
    loadDotenv({ path: envFile, override: false });
  }
  const parsed = configSchema.safeParse(options?.env ?? process.env);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Configuration error: ${message}`);
  }
  const env = parsed.data;
  return {
    port: env.PORT,
    host: env.HOST,
    dataDir: resolve(repoRoot, env.DATA_DIR),
    apiKey: env.API_KEY,
    museUrl: env.MUSE_URL,
    headless: env.HEADLESS ?? true,
    browserChannel: env.BROWSER_CHANNEL,
    maxConcurrentTurns: env.MAX_CONCURRENT_TURNS,
    warmThreads: env.WARM_THREADS,
    queueTimeoutSec: env.QUEUE_TIMEOUT_SEC,
    requestTimeoutSec: env.REQUEST_TIMEOUT_SEC,
    stallTimeoutSec: env.STALL_TIMEOUT_SEC,
    sessionTtlSec: env.SESSION_TTL_SEC,
    cacheTtlSec: env.CACHE_TTL_SEC,
    logLevel: env.LOG_LEVEL,
  };
}
