export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export type ToolChoice = "auto" | "none" | "required" | { name: string };

export interface ChatMessage {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  isError?: boolean;
}

export type Effort = "none" | "low" | "medium" | "high" | "xhigh";

/** Muse composer modes. `default` leaves whatever the page currently has selected. */
export type MuseMode = "default" | "instant" | "thinking" | "contemplating";

export interface ChatRequest {
  requestId: string;
  dialect: "openai" | "anthropic";
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  effort?: Effort;
  maxTokens?: number;
  conversationHint?: string;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  clientAbort: AbortSignal;
}

export type TurnEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "thinking_delta"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; argumentsJson: string }
  | {
      type: "error";
      kind: "rate_limit" | "auth" | "timeout" | "browser" | "unknown";
      message: string;
      retryAfterSec?: number;
    }
  | { type: "done"; stopReason: "end_turn" | "tool_use" | "error" };

export interface TurnInput {
  requestId: string;
  prompt: string;
  mode: MuseMode;
  /** Existing Muse conversation to continue; undefined starts a new chat. */
  conversationId?: string;
  signal: AbortSignal;
}

export interface DriverStatus {
  browserOpen: boolean;
  activeTurns: number;
  maxConcurrentTurns: number;
}

export interface MuseDriver {
  /** Runs one browser turn. Every failure surfaces as an `error` event followed by `done`. */
  runTurn(input: TurnInput, emit: (event: TurnEvent) => void): Promise<void>;
  status(): Promise<DriverStatus>;
  close(): Promise<void>;
}
