import { createHash } from "node:crypto";
import type { ChatMessage, MuseMode, ToolDefinition } from "../core/types.js";
import { JsonStore } from "../store/json-store.js";

export interface SessionRow {
  fingerprint: string;
  conversationId: string;
  mode: MuseMode;
  turns: number;
  lastUsedAt: number;
  expiresAt: number;
}

function normalizeMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.trim(),
    ...(message.toolCalls
      ? {
          toolCalls: message.toolCalls.map((call) => ({ id: call.id, name: call.name, argumentsJson: call.argumentsJson })),
        }
      : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.isError === undefined ? {} : { isError: message.isError }),
    // A digest, not the raw bytes, keeps sessions.json small while still distinguishing histories
    // that share the same text but attached different files.
    ...(message.attachments && message.attachments.length > 0
      ? {
          attachments: message.attachments.map((a) => `${a.filename}:${a.mediaType}:${createHash("sha256").update(a.data).digest("hex")}`),
        }
      : {}),
  }));
}

function normalizeTools(tools: ToolDefinition[] | undefined): Array<{ name: string; parameters: Record<string, unknown> }> {
  return (tools ?? []).map((tool) => ({ name: tool.name, parameters: tool.parameters }));
}

/** Identity of a conversation state: the client hint plus every message so far. */
export function fingerprint(conversationHint: string | undefined, messages: ChatMessage[], tools?: ToolDefinition[]): string {
  const toolHash = createHash("sha256").update(JSON.stringify(normalizeTools(tools))).digest("hex");
  const payload = `${conversationHint ?? ""}|${toolHash}|${JSON.stringify(normalizeMessages(messages))}`;
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Fingerprint of the history *before* the newest message, i.e. the state a previous
 * response left behind. Null when the request cannot be a follow-up.
 */
export function lookupFingerprint(conversationHint: string | undefined, messages: ChatMessage[], tools?: ToolDefinition[]): string | null {
  const nonSystem = messages.filter((message) => message.role !== "system");
  if (nonSystem.length < 2) return null;
  const newestRole = messages[messages.length - 1]?.role;
  if (newestRole !== "user" && newestRole !== "tool") return null;
  let prefixEnd = newestRole === "user" ? messages.length - 1 : messages.length;
  while (prefixEnd > 0 && messages[prefixEnd - 1]?.role === "tool") prefixEnd--;
  return fingerprint(conversationHint, messages.slice(0, prefixEnd), tools);
}

export class SessionStore {
  private readonly store: JsonStore<SessionRow>;

  constructor(path: string) {
    this.store = new JsonStore<SessionRow>(path);
  }

  find(fp: string, now: number): SessionRow | undefined {
    const row = this.store.get(fp);
    if (!row) return undefined;
    if (row.expiresAt <= now) {
      this.store.delete(fp);
      return undefined;
    }
    return row;
  }

  /** Moves the conversation from the fingerprint it was found under to the new one. */
  replace(oldFingerprint: string | null, row: SessionRow): void {
    if (oldFingerprint && oldFingerprint !== row.fingerprint) this.store.delete(oldFingerprint);
    this.store.set(row.fingerprint, row);
  }

  delete(fp: string): void {
    this.store.delete(fp);
  }

  pruneExpired(now: number): number {
    return this.store.prune((row) => row.expiresAt > now);
  }

  get size(): number {
    return this.store.size;
  }

  flush(): void {
    this.store.flush();
  }
}
