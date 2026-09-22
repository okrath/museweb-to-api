import type { FastifyReply, FastifyRequest } from "fastify";
import type { ChatRequest, TurnEvent } from "../core/types.js";
import {
  isMappedError,
  mapProtocolError,
  mapRouteError,
  ProtocolError,
  RouteError,
  sendMappedError,
} from "../protocol/errors.js";
import { openAiIncludeUsage, type NormalizeInput } from "../protocol/normalize-openai.js";
import { anthropicStreamFrames, serializeAnthropicMessage } from "../protocol/serialize-anthropic.js";
import { openAiStreamFrames, serializeOpenAiCompletion } from "../protocol/serialize-openai.js";
import { setStreamHeaders, startHeartbeat, writeComment, writeFrame } from "../protocol/sse.js";
import { routeRequest, type RouteDeps, type RouteMeta } from "../router/route-request.js";

const HEARTBEAT_MS = 15_000;

export function createRequestId(request: FastifyRequest): string {
  return `req_${request.id.replace(/-/g, "").slice(0, 21)}`;
}

function wireClientAbort(request: FastifyRequest): AbortController {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  request.raw.on("close", abort);
  request.socket?.on("close", abort);
  if (request.socket?.destroyed) abort();
  return controller;
}

export function metaHeaders(meta: RouteMeta): Record<string, string> {
  const headers: Record<string, string> = {
    "x-mta-model": meta.model,
    "x-mta-mode": meta.mode,
    "x-mta-session-reused": meta.sessionReused ? "1" : "0",
    "x-mta-cache-hit": meta.cacheHit ? "1" : "0",
    "x-mta-warm-thread": meta.warmThread ? "1" : "0",
  };
  if (meta.conversationId) headers["x-mta-conversation-id"] = meta.conversationId;
  return headers;
}

export function wrapNormalize(normalize: (input: NormalizeInput) => ChatRequest) {
  return (request: FastifyRequest, reply: FastifyReply, body: unknown): ChatRequest | undefined => {
    try {
      const controller = wireClientAbort(request);
      const requestId = createRequestId(request);
      request.chatRequestId = requestId;
      return normalize({ body, headers: request.headers, requestId, clientAbort: controller.signal });
    } catch (err) {
      if (err instanceof ProtocolError) {
        sendMappedError(reply, mapProtocolError(err));
        return undefined;
      }
      throw err;
    }
  };
}

async function collect(events: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

export async function handleChatRequest(
  reply: FastifyReply,
  chatRequest: ChatRequest,
  rawBody: unknown,
  deps: RouteDeps,
): Promise<void> {
  reply.header("x-mta-request-id", chatRequest.requestId);

  let routed: Awaited<ReturnType<typeof routeRequest>>;
  try {
    routed = await routeRequest(chatRequest, deps);
  } catch (err) {
    if (err instanceof RouteError) {
      sendMappedError(reply, mapRouteError(err, chatRequest.dialect));
      return;
    }
    throw err;
  }

  const headers = metaHeaders(routed.meta);
  for (const [name, value] of Object.entries(headers)) reply.header(name, value);
  const opts = { requestId: chatRequest.requestId, model: chatRequest.model };

  if (!chatRequest.stream) {
    const events = await collect(routed.events);
    const body =
      chatRequest.dialect === "openai"
        ? serializeOpenAiCompletion(events, opts)
        : serializeAnthropicMessage(events, opts);
    if ("status" in body) {
      reply.code(body.status).send(body.body);
      return;
    }
    reply.send(body);
    return;
  }

  let headersSent = false;
  let waiting = true;
  const heartbeat = startHeartbeat(HEARTBEAT_MS, () => {
    if (headersSent && waiting) {
      if (chatRequest.dialect === "openai") writeComment(reply.raw, "ping");
      else writeFrame(reply.raw, "{}", "ping");
    }
  });
  const open = () => {
    if (headersSent) return;
    setStreamHeaders(reply.raw, { ...reply.getHeaders(), "x-mta-request-id": chatRequest.requestId, ...headers });
    reply.hijack();
    headersSent = true;
  };

  try {
    if (chatRequest.dialect === "openai") {
      const includeUsage = openAiIncludeUsage(rawBody);
      for await (const frame of openAiStreamFrames(routed.events, opts)) {
        waiting = false;
        open();
        if (frame === "[DONE]") {
          if (includeUsage) {
            // Muse exposes no token counts; the usage chunk is present but zero so SDKs that
            // expect it keep working.
            writeFrame(
              reply.raw,
              JSON.stringify({
                id: `chatcmpl-${chatRequest.requestId}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: chatRequest.model,
                choices: [],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
              }),
            );
          }
          writeFrame(reply.raw, "[DONE]");
        } else {
          writeFrame(reply.raw, frame);
        }
        waiting = true;
      }
    } else {
      for await (const frame of anthropicStreamFrames(routed.events, opts)) {
        waiting = false;
        open();
        writeFrame(reply.raw, JSON.stringify(frame.data), frame.event);
        waiting = true;
      }
    }
  } catch (err) {
    if (isMappedError(err) && !headersSent) {
      sendMappedError(reply, err);
      return;
    }
    throw err;
  } finally {
    heartbeat.stop();
  }
  if (headersSent) reply.raw.end();
}

declare module "fastify" {
  interface FastifyRequest {
    chatRequestId?: string;
  }
}
