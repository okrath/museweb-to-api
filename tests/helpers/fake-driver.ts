import type { DriverStatus, MuseDriver, TurnEvent, TurnInput } from "../../src/core/types.js";

export interface FakeTurnScript {
  /** Markdown chunks streamed as text deltas. */
  chunks?: string[];
  conversationId?: string;
  error?: Extract<TurnEvent, { type: "error" }>;
  /** Delay between chunks, for abort tests. */
  delayMs?: number;
}

/**
 * Scripted stand-in for the browser driver. Records every TurnInput so tests can assert
 * what prompt and conversation the router asked for.
 */
export class FakeDriver implements MuseDriver {
  readonly calls: TurnInput[] = [];
  private readonly scripts: FakeTurnScript[] = [];
  private fallback: FakeTurnScript = { chunks: ["Hello from Muse.\n\n", "Second paragraph."] };
  private newThreadCount = 0;

  enqueue(script: FakeTurnScript): this {
    this.scripts.push(script);
    return this;
  }

  setFallback(script: FakeTurnScript): this {
    this.fallback = script;
    return this;
  }

  async runTurn(input: TurnInput, emit: (event: TurnEvent) => void): Promise<void> {
    this.calls.push(input);
    const script = this.scripts.shift() ?? this.fallback;
    if (script.error) {
      emit(script.error);
      emit({ type: "done", stopReason: "error" });
      return;
    }
    for (const chunk of script.chunks ?? []) {
      if (script.delayMs) await new Promise((resolve) => setTimeout(resolve, script.delayMs));
      if (input.signal.aborted) return;
      emit({ type: "text_delta", text: chunk });
    }
    let conversationId = script.conversationId ?? input.conversationId;
    if (!input.conversationId) {
      this.newThreadCount++;
      conversationId ??= `https://muse.ai/c/${this.newThreadCount === 1 ? "abc" : `fake-${this.newThreadCount}`}`;
    }
    if (conversationId) emit({ type: "conversation", conversationId });
    emit({ type: "done", stopReason: "end_turn" });
  }

  async status(): Promise<DriverStatus> {
    return { browserOpen: true, activeTurns: 0, maxConcurrentTurns: 2 };
  }

  async close(): Promise<void> {}
}
