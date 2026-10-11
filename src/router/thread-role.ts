import type { Attachment, ChatRequest, MuseMode, ToolCall, TurnEvent } from "../core/types.js";
import { renderTranscript } from "../prompt/render-transcript.js";
import { renderToolProtocol } from "../prompt/tool-protocol.js";
import type { SessionRow, SessionStore } from "../sessions/session-store.js";
import type { ThreadRegistry } from "../sessions/thread-registry.js";

export type ThreadRole = "primary" | "side";

export const DEFAULT_PRIMARY_TOOLS = ["task", "Task", "Agent"] as const;

/**
 * Only the main agent carries a delegation tool (`task` in omp, `Task`/`Agent` in Claude Code);
 * its subagents and tool-less requests such as title generation never do, so they get a side
 * thread and can never rotate the primary.
 */
export function threadRole(
  req: { tools?: Array<{ name: string }> },
  primaryToolNames: readonly string[],
): ThreadRole {
  return req.tools?.some((tool) => primaryToolNames.includes(tool.name)) ? "primary" : "side";
}

/**
 * Validates whether a matching session can be resumed.
 * - Primary requests can only resume the registry's current primary thread.
 * - Side requests can resume any non-primary, non-retired thread.
 */
export function pickResumeSession(
  found: SessionRow | undefined,
  mode: MuseMode,
  role: ThreadRole,
  registry?: ThreadRegistry,
): SessionRow | undefined {
  if (!found || found.mode !== mode) return undefined;
  if (!registry) return found;
  if (role === "primary") {
    return registry.primary()?.conversationId === found.conversationId ? found : undefined;
  }
  const row = registry.get(found.conversationId);
  if (row?.role === "primary" || row?.role === "retired") return undefined;
  return found;
}

/**
 * Records the turn outcome in the registry:
 * - For primary, promotes the thread and retires any previous primary, deleting its session rows.
 * - For side, records or updates the side thread.
 */
export function registerTurnOutcome(
  deps: {
    registry?: ThreadRegistry;
    sessions: SessionStore;
    reaper?: { check: () => void | Promise<void> };
  },
  role: ThreadRole,
  conversationId: string,
  now: number,
): void {
  if (!deps.registry) return;
  if (role === "primary") {
    const prevPrimaryId = deps.registry.setPrimary(conversationId, now);
    if (prevPrimaryId && prevPrimaryId !== conversationId) {
      deps.sessions.deleteByConversation(prevPrimaryId);
      if (deps.reaper?.check) {
        queueMicrotask(() => deps.reaper?.check());
      }
    }
  } else {
    deps.registry.touchSide(conversationId, now);
  }
}

export function shouldRetryFresh(
  req: ChatRequest,
  outcome: { text: string; thinking: string; toolCalls: ToolCall[]; error?: Extract<TurnEvent, { type: "error" }> },
): boolean {
  const err = outcome.error;
  return Boolean(
    err && err.kind !== "rate_limit" && err.kind !== "auth" &&
    !outcome.text && !outcome.thinking && outcome.toolCalls.length === 0 && !req.clientAbort.aborted,
  );
}

export function attachmentsForRequest(req: ChatRequest): Attachment[] | undefined {
  const newest = req.messages[req.messages.length - 1];
  return newest?.role === "user" ? newest.attachments : undefined;
}

export function promptForRequest(req: ChatRequest, resume: boolean): string {
  const hasTools = Boolean(req.tools && req.tools.length > 0) && req.toolChoice !== "none";
  const toolProtocol = !resume && hasTools ? renderToolProtocol(req.tools!, req.toolChoice) : undefined;
  return renderTranscript(req.messages, { resume, toolProtocol, toolsActive: resume && hasTools });
}

export function retireOnRetryFresh(
  deps: { registry?: ThreadRegistry; sessions: SessionStore },
  conversationId: string | undefined,
  sessionFp?: string | null,
): void {
  if (conversationId) {
    deps.registry?.retire(conversationId);
    deps.sessions.deleteByConversation(conversationId);
  }
  if (sessionFp) {
    deps.sessions.delete(sessionFp);
  }
}
