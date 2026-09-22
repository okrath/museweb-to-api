import cors from "@fastify/cors";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "pino";
import { registerApiRoutes, registerHealthRoute } from "./api/routes.js";
import { apiKeyPreHandler } from "./auth/api-key.js";
import type { ResponseCache } from "./cache/response-cache.js";
import type { GatewayConfig } from "./config.js";
import type { MuseDriver } from "./core/types.js";
import { TurnSlots } from "./router/slots.js";
import { WarmThreadPool } from "./router/warm-pool.js";
import type { SessionStore } from "./sessions/session-store.js";

export interface BuildServerDeps {
  config: GatewayConfig;
  apiKey: string;
  driver: MuseDriver;
  sessions: SessionStore;
  cache: ResponseCache;
  version: string;
  logger?: Logger | false;
}

export async function buildServer(deps: BuildServerDeps): Promise<FastifyInstance> {
  const logging =
    deps.logger === undefined
      ? {
          logger: {
            level: deps.config.logLevel,
            transport: process.env.NODE_ENV === "production" ? undefined : { target: "pino-pretty", options: { colorize: true } },
          },
        }
      : deps.logger === false
        ? { logger: false as const }
        : { loggerInstance: deps.logger as unknown as FastifyBaseLogger };
  const app = Fastify({
    ...logging,
    genReqId: () => randomUUID(),
    bodyLimit: 256 * 1024 * 1024,
  });

  await app.register(cors, { origin: true });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-mta-request-id", request.chatRequestId ?? request.id);
    return payload;
  });

  registerHealthRoute(app, deps.version, deps.driver);

  const slots = new TurnSlots(deps.config.maxConcurrentTurns);
  const warmPool = new WarmThreadPool({
    path: join(deps.config.dataDir, "warm-threads.json"),
    ttlSec: deps.config.sessionTtlSec,
    target: deps.config.warmThreads,
    driver: deps.driver,
    slots,
    log: app.log as unknown as Logger,
  });
  app.addHook("onListen", () => warmPool.start());
  app.addHook("onClose", async () => warmPool.stop());

  await app.register(
    async (scope) => {
      scope.addHook("preHandler", apiKeyPreHandler(deps.apiKey));
      registerApiRoutes(scope, {
        config: deps.config,
        driver: deps.driver,
        sessions: deps.sessions,
        cache: deps.cache,
        slots,
        warmPool,
        log: app.log as Logger,
      });
    },
    { prefix: "/v1" },
  );

  return app;
}
