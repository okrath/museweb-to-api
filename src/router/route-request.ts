import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import { cacheKey, replayCachedEvents, type ResponseCache } from "../cache/response-cache.js";
import type { GatewayConfig } from "../config.js";
import type { ChatMessage, ChatRequest, MuseDriver, MuseMode, ToolCall, TurnEvent } from "../core/types.js";
import { announcesWithoutRequest, createToolTextFilter, missingRequestNudge } from "../prompt/tool-protocol.js";
import { RouteError } from "../protocol/errors.js";
import { findModel, resolveMode } from "../protocol/models.js";
import { fingerprint, lookupFingerprint, type SessionStore } from "../sessions/session-store.js";
import type { ThreadRegistry } from "../sessions/thread-registry.js";
import { createEventChannel } from "./event-channel.js";
import type { TurnSlots } from "./slots.js";
import {
  attachmentsForRequest,
  DEFAULT_PRIMARY_TOOLS,
  pickResumeSession,
  promptForRequest,
  registerTurnOutcome,
  retireOnRetryFresh,
  shouldRetryFresh,
  threadRole,
  type ThreadRole,
} from "./thread-role.js";
import type { WarmThreadPool } from "./warm-pool.js";

export interface RouteMeta {
  model: string;
  mode: MuseMode;
  sessionReused: boolean;
  cacheHit: boolean;
  warmThread: boolean;
  /** Known up front for a resumed conversation or cache hit. */
  conversationId?: string;
  threadRole: ThreadRole;
}

export interface RouteDeps {
  config: Pick<GatewayConfig, "cacheTtlSec" | "sessionTtlSec" | "queueTimeoutSec">;
  driver: MuseDriver;
  sessions: SessionStore;
  cache: ResponseCache;
  slots: TurnSlots;
  warmPool?: WarmThreadPool;
  registry?: ThreadRegistry;
  primaryToolNames?: readonly string[];
  reaper?: { check: () => void | Promise<void> };
  log: Pick<Logger, "debug" | "info" | "warn" | "error">;
  now?: () => number;
}

interface TurnOutcome {
  text: string;
  thinking: string;
  toolCalls: ToolCall[];
  conversationId?: string;
  error?: Extract<TurnEvent, { type: "error" }>;
}

function createToolCallId(): string {
  return `call_${randomBytes(18).toString("base64url")}`;
}

/**
 * Runs one driver turn and forwards its events. With `holdUntilContent` the events are held
 * back until the first content delta, so a resumed conversation that dies before answering
 * can be retried as a fresh chat without the client seeing the failed attempt.
 */
async function runOnce(
  deps: RouteDeps,
  req: ChatRequest,
  prompt: string,
  mode: MuseMode,
  conversationId: string | undefined,
  emit: (event: TurnEvent) => void,
  holdUntilContent: boolean,
): Promise<{ outcome: TurnOutcome; held: TurnEvent[] }> {
  const outcome: TurnOutcome = { text: "", thinking: "", toolCalls: [], conversationId };
  const held: TurnEvent[] = [];
  const streamed = { text: "" };
  const forward = (event: TurnEvent) => {
    const hasContent =
      outcome.text.length > 0 || outcome.thinking.length > 0 || outcome.toolCalls.length > 0 || streamed.text.length > 0;
    if (holdUntilContent && !hasContent) {
      held.push(event);
      return;
    }
    for (const earlier of held.splice(0)) emit(earlier);
    emit(event);
  };

  const turn = { deps, req, mode, outcome, forward, streamed };
  const first = await runDriverTurn(turn, prompt, conversationId, true);
  // One nudge, in the same thread, when Muse announced an action but sent no request block.
  if (first.announcedOnly && outcome.conversationId && !req.clientAbort.aborted) {
    deps.log.info({ requestId: req.requestId, conversationId: outcome.conversationId }, "Muse announced an action without a request; nudging once");
    await runDriverTurn(turn, missingRequestNudge, outcome.conversationId, false);
  }
  return { outcome, held };
}

interface DriverTurnState {
  deps: RouteDeps;
  req: ChatRequest;
  mode: MuseMode;
  outcome: TurnOutcome;
  forward: (event: TurnEvent) => void;
  streamed: { text: string };
}

/**
 * One driver turn feeding `outcome`; a second call continues the same reply. With `mayNudge`, a
 * tool reply that only announces an action holds back its `done` and returns `announcedOnly`.
 */
async function runDriverTurn(
  state: DriverTurnState,
  prompt: string,
  conversationId: string | undefined,
  mayNudge: boolean,
): Promise<{ announcedOnly: boolean }> {
  const { deps, req, mode, outcome, forward, streamed } = state;
  const now = deps.now ?? Date.now;
  if (conversationId && deps.registry) deps.registry.begin(conversationId);
  const toolFilter = req.tools && req.tools.length > 0 ? createToolTextFilter() : undefined;
  const textBefore = outcome.text;
  let separate = textBefore.length > 0;
  let announcedOnly = false;
  const sendToolText = (text: string) => {
    if (text.length === 0) return;
    const delta = separate ? `\n\n${text}` : text;
    separate = false;
    streamed.text += delta;
    forward({ type: "text_delta", text: delta });
  };

  try {
    await deps.driver.runTurn(
      {
        requestId: req.requestId,
        prompt,
        mode,
        conversationId,
        attachments: mayNudge ? attachmentsForRequest(req) : undefined,
        signal: req.clientAbort,
      },
      (event) => {
        if (event.type === "text_delta") {
          if (toolFilter) {
            const safe = toolFilter.append(event.text);
            if (req.stream) sendToolText(safe);
          } else {
            outcome.text += event.text;
            forward(event);
          }
        } else if (event.type === "thinking_delta") {
          outcome.thinking += event.text;
          forward(event);
        } else if (event.type === "conversation") {
          outcome.conversationId = event.conversationId;
          forward(event);
        } else if (event.type === "error") {
          outcome.error = event;
          forward(event);
        } else if (event.type === "tool_call") {
          outcome.toolCalls.push({ id: event.id, name: event.name, argumentsJson: event.argumentsJson });
          forward(event);
        } else if (toolFilter) {
          const parsed = toolFilter.finish();
          outcome.text = [textBefore, parsed.text].filter((part) => part.length > 0).join("\n\n");
          outcome.toolCalls = parsed.calls.map((call) => ({ id: createToolCallId(), ...call }));
          sendToolText(req.stream ? parsed.unsentText : parsed.text);
          for (const call of outcome.toolCalls) {
            forward({ type: "tool_call", id: call.id, name: call.name, argumentsJson: call.argumentsJson });
          }
          if (mayNudge && !outcome.error && outcome.toolCalls.length === 0 && announcesWithoutRequest(parsed.text)) {
            announcedOnly = true;
            return;
          }
          forward({ type: "done", stopReason: outcome.toolCalls.length > 0 ? "tool_use" : "end_turn" });
        } else {
          forward(event);
        }
      },
    );
    return { announcedOnly };
  } finally {
    if (conversationId && deps.registry) deps.registry.end(conversationId, now());
  }
}

export async function routeRequest(
  req: ChatRequest,
  deps: RouteDeps,
): Promise<{ events: AsyncIterable<TurnEvent>; meta: RouteMeta }> {
  const now = deps.now ?? Date.now;
  const model = findModel(req.model);
  if (!model) throw new RouteError("model_not_found", `Unknown model "${req.model}"`);
  const mode = resolveMode(model, req.effort);
  const hasTools = Boolean(req.tools && req.tools.length > 0);
  const role = threadRole(req, deps.primaryToolNames ?? DEFAULT_PRIMARY_TOOLS);

  const cacheEnabled = deps.config.cacheTtlSec > 0;
  const key = cacheKey(model.id, mode, req.maxTokens, req.messages, req.tools);
  if (cacheEnabled && !hasTools) {
    const cached = deps.cache.get(key, now());
    if (cached) {
      return {
        events: replayCachedEvents(cached),
        meta: {
          model: model.id,
          mode,
          sessionReused: false,
          cacheHit: true,
          warmThread: false,
          conversationId: cached.conversationId,
          threadRole: role,
        },
      };
    }
  }

  const sessionsEnabled = deps.config.sessionTtlSec > 0;
  const sessionFp = sessionsEnabled ? lookupFingerprint(req.conversationHint, req.messages, req.tools) : null;
  const found = sessionFp ? deps.sessions.find(sessionFp, now()) : undefined;
  const resume = pickResumeSession(found, mode, role, deps.registry);

  const release = await deps.slots.acquire(deps.config.queueTimeoutSec * 1000, req.clientAbort);
  if (!release) {
    if (req.clientAbort.aborted) {
      throw new RouteError("client_aborted", "Client disconnected while waiting for a browser slot");
    }
    throw new RouteError("queue_timeout", "All browser slots are busy", deps.config.queueTimeoutSec);
  }

  const warmThread = !resume ? deps.warmPool?.take(now()) : undefined;
  const channel = createEventChannel();
  const meta: RouteMeta = {
    model: model.id,
    mode,
    sessionReused: Boolean(resume),
    cacheHit: false,
    warmThread: Boolean(warmThread),
    conversationId: resume?.conversationId,
    threadRole: role,
  };

  if (warmThread) deps.warmPool?.check();

  const finish = (outcome: TurnOutcome, resumed: boolean) => {
    if (outcome.error || (outcome.text.length === 0 && outcome.toolCalls.length === 0)) {
      // A failed turn may still have created a Muse thread; record it as side so the reaper
      // deletes it once idle instead of leaving it in the panel for good.
      if (outcome.conversationId && deps.registry && !deps.registry.get(outcome.conversationId)) {
        deps.registry.touchSide(outcome.conversationId, now());
      }
      return;
    }
    const finishedAt = now();
    if (sessionsEnabled && outcome.conversationId) {
      const assistant: ChatMessage = { role: "assistant", content: outcome.text };
      if (outcome.toolCalls.length > 0) assistant.toolCalls = outcome.toolCalls;
      const nextFp = fingerprint(req.conversationHint, [...req.messages, assistant], req.tools);
      deps.sessions.replace(resumed ? sessionFp : null, {
        fingerprint: nextFp,
        conversationId: outcome.conversationId,
        mode,
        turns: (resumed ? resume?.turns ?? 0 : 0) + 1,
        lastUsedAt: finishedAt,
        expiresAt: finishedAt + deps.config.sessionTtlSec * 1000,
      });
    }
    if (cacheEnabled && !hasTools) {
      deps.cache.set(
        key,
        { text: outcome.text, thinking: outcome.thinking, conversationId: outcome.conversationId },
        deps.config.cacheTtlSec,
        finishedAt,
      );
    }
    if (outcome.conversationId) {
      registerTurnOutcome(deps, role, outcome.conversationId, finishedAt);
    }
  };

  void (async () => {
    try {
      if (resume) {
        const first = await runOnce(deps, req, promptForRequest(req, true), mode, resume.conversationId, channel.emit, true);
        const error = first.outcome.error;
        if (shouldRetryFresh(req, first.outcome) && error) {
          deps.log.warn(
            { requestId: req.requestId, conversationId: resume.conversationId, error: error.message },
            "Resumed Muse conversation failed before answering; retrying as a fresh chat",
          );
          retireOnRetryFresh(deps, resume.conversationId, sessionFp);
          meta.sessionReused = false;
          meta.conversationId = undefined;
          const second = await runOnce(deps, req, promptForRequest(req, false), mode, undefined, channel.emit, false);
          finish(second.outcome, false);
        } else {
          for (const event of first.held) channel.emit(event);
          finish(first.outcome, true);
        }
      } else if (warmThread) {
        const first = await runOnce(
          deps,
          req,
          promptForRequest(req, false),
          mode,
          warmThread.conversationId,
          channel.emit,
          true,
        );
        const error = first.outcome.error;
        if (shouldRetryFresh(req, first.outcome) && error) {
          deps.log.warn(
            { requestId: req.requestId, conversationId: warmThread.conversationId, error: error.message },
            "Warm Muse conversation failed before answering; retrying as a fresh chat",
          );
          retireOnRetryFresh(deps, warmThread.conversationId);
          const second = await runOnce(deps, req, promptForRequest(req, false), mode, undefined, channel.emit, false);
          finish(second.outcome, false);
        } else {
          for (const event of first.held) channel.emit(event);
          finish(first.outcome, false);
        }
      } else {
        const only = await runOnce(deps, req, promptForRequest(req, false), mode, undefined, channel.emit, false);
        finish(only.outcome, false);
      }
    } catch (err) {
      deps.log.error({ requestId: req.requestId, err }, "Muse driver threw");
      channel.emit({ type: "error", kind: "browser", message: err instanceof Error ? err.message : String(err) });
      channel.emit({ type: "done", stopReason: "error" });
    } finally {
      channel.close();
      release();
      queueMicrotask(() => deps.warmPool?.check());
    }
  })();

  return { events: channel.events, meta };
}
