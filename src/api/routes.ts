import type { FastifyInstance } from "fastify";
import type { MuseDriver } from "../core/types.js";
import { listAnthropicModels, listOpenAiModels } from "../protocol/models.js";
import { normalizeAnthropic } from "../protocol/normalize-anthropic.js";
import { normalizeOpenAi } from "../protocol/normalize-openai.js";
import { mapTurnError, sendMappedError } from "../protocol/errors.js";
import type { RouteDeps } from "../router/route-request.js";
import { handleChatRequest, wrapNormalize } from "./chat-handler.js";

const startedAt = Date.now();

export function registerHealthRoute(app: FastifyInstance, version: string, driver: MuseDriver): void {
  app.get("/healthz", async () => ({
    ok: true,
    version,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    browser: await driver.status(),
  }));
}

export function registerApiRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const openAi = wrapNormalize(normalizeOpenAi);
  const anthropic = wrapNormalize(normalizeAnthropic);

  app.get("/models", async (request) => {
    const anthropicVersion = request.headers["anthropic-version"];
    return typeof anthropicVersion === "string" && anthropicVersion.length > 0
      ? listAnthropicModels()
      : listOpenAiModels();
  });

  /** Muse's own account quota (Settings > General), not token counts: those are always zero. */
  app.get("/usage", async (_request, reply) => {
    const outcome = await deps.driver.getUsage();
    if (!outcome.ok) {
      sendMappedError(
        reply,
        mapTurnError({ type: "error", kind: outcome.kind, message: outcome.message, retryAfterSec: outcome.retryAfterSec }, "openai"),
      );
      return;
    }
    return outcome.report;
  });

  app.post("/chat/completions", async (request, reply) => {
    const chatRequest = openAi(request, reply, request.body);
    if (!chatRequest) return;
    await handleChatRequest(reply, chatRequest, request.body, deps);
  });

  app.post("/messages", async (request, reply) => {
    const chatRequest = anthropic(request, reply, request.body);
    if (!chatRequest) return;
    await handleChatRequest(reply, chatRequest, request.body, deps);
  });
}
