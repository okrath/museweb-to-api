import { createHash } from "node:crypto";
import type { ChatMessage, MuseMode, ToolDefinition, TurnEvent } from "../core/types.js";
import { JsonStore } from "../store/json-store.js";

export interface CachedBody {
  thinking: string;
  text: string;
  conversationId?: string;
}

interface CacheRow extends CachedBody {
  createdAt: number;
  expiresAt: number;
}

export function cacheKey(
  modelId: string,
  mode: MuseMode,
  maxTokens: number | undefined,
  messages: ChatMessage[],
  tools?: ToolDefinition[],
): string {
  const toolHash = createHash("sha256")
    .update(JSON.stringify((tools ?? []).map((tool) => ({ name: tool.name, parameters: tool.parameters }))))
    .digest("hex");
  const payload = [modelId, mode, maxTokens ?? "", toolHash, JSON.stringify(messages)].join("|");
  return createHash("sha256").update(payload).digest("hex");
}

export class ResponseCache {
  private readonly store: JsonStore<CacheRow>;

  constructor(path: string) {
    this.store = new JsonStore<CacheRow>(path);
  }

  get(key: string, now: number): CachedBody | null {
    const row = this.store.get(key);
    if (!row) return null;
    if (row.expiresAt <= now) {
      this.store.delete(key);
      return null;
    }
    return { thinking: row.thinking, text: row.text, conversationId: row.conversationId };
  }

  set(key: string, body: CachedBody, ttlSec: number, now: number): void {
    this.store.set(key, { ...body, createdAt: now, expiresAt: now + ttlSec * 1000 });
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

export async function* replayCachedEvents(body: CachedBody): AsyncGenerator<TurnEvent> {
  if (body.conversationId) yield { type: "conversation", conversationId: body.conversationId };
  if (body.thinking.length > 0) yield { type: "thinking_delta", text: body.thinking };
  if (body.text.length > 0) yield { type: "text_delta", text: body.text };
  yield { type: "done", stopReason: "end_turn" };
}
