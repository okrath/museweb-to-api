import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { ResponseCache } from "../../src/cache/response-cache.js";
import type { GatewayConfig } from "../../src/config.js";
import { buildServer } from "../../src/server.js";
import { SessionStore } from "../../src/sessions/session-store.js";
import { FakeDriver } from "./fake-driver.js";

export interface TestGateway {
  app: FastifyInstance;
  driver: FakeDriver;
  sessions: SessionStore;
  cache: ResponseCache;
  apiKey: string;
  dataDir: string;
  close: () => Promise<void>;
}

export function testConfig(dataDir: string, overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir,
    museUrl: "https://muse.ai/",
    headless: true,
    maxConcurrentTurns: 2,
    warmThreads: 0,
    queueTimeoutSec: 1,
    requestTimeoutSec: 60,
    stallTimeoutSec: 30,
    sessionTtlSec: 3600,
    cacheTtlSec: 300,
    logLevel: "silent",
    ...overrides,
  };
}

export async function startTestGateway(overrides?: Partial<GatewayConfig>): Promise<TestGateway> {
  const dataDir = mkdtempSync(join(tmpdir(), "museweb-to-api-test-"));
  const config = testConfig(dataDir, overrides);
  const driver = new FakeDriver();
  const sessions = new SessionStore(join(dataDir, "sessions.json"));
  const cache = new ResponseCache(join(dataDir, "response-cache.json"));
  const apiKey = "sk-mta-test";
  const app = await buildServer({ config, apiKey, driver, sessions, cache, version: "test", logger: false });
  await app.listen({ port: config.port, host: config.host });
  return {
    app,
    driver,
    sessions,
    cache,
    apiKey,
    dataDir,
    close: async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function parseSse(payload: string): Array<{ event?: string; data: string }> {
  return payload
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0 && !block.startsWith(":"))
    .map((block) => {
      let event: string | undefined;
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data.push(line.slice(6));
      }
      return { event, data: data.join("\n") };
    });
}
