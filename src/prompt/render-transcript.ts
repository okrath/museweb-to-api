import type { ChatMessage } from "../core/types.js";
import { renderToolReminder, renderToolResultBlocks, renderToolResults } from "./tool-protocol.js";

export interface TranscriptOptions {
  resume?: boolean;
  toolProtocol?: string;
  /** Resumed turn still expects function-call replies; see `renderToolReminder`. */
  toolsActive?: boolean;
}

function renderResumedTranscript(messages: ChatMessage[], toolsActive: boolean): string {
  const conversation = messages.filter((message) => message.role !== "system");
  const withReminder = (text: string) => (toolsActive ? `${renderToolReminder()}\n\n${text}` : text);

  const lastToolIndex = conversation.map((message) => message.role).lastIndexOf("tool");
  if (lastToolIndex >= 0) {
    let flowStart = 0;
    for (let index = lastToolIndex; index >= 0; index--) {
      if (conversation[index]?.role === "assistant" && (conversation[index]?.toolCalls?.length ?? 0) > 0) {
        flowStart = index;
        break;
      }
    }
    const flow = conversation.slice(flowStart);
    const newestUserIndex = flow.map((message) => message.role).lastIndexOf("user");
    const resultMarkers = flow
      .filter((message) => message.role === "tool" && message.toolCallId)
      .map((message) => `[tool_result id=${message.toolCallId}]`)
      .join("\n");
    if (newestUserIndex > lastToolIndex - flowStart) {
      const results = renderToolResultBlocks(flow);
      const promptResults = resultMarkers.length > 0 ? `${resultMarkers}\n${results}` : results;
      const userText = flow[newestUserIndex]!.content;
      // A plain follow-up question after an earlier function round: nothing else here reminds
      // Muse that function calls are still expected, so this is the path that most needs it.
      return withReminder(promptResults.length > 0 ? `${promptResults}\n\n${userText}` : userText);
    }
    // Continuing the function round directly: `renderToolResults` already appends its own
    // "Continue: ..." instruction, so no second reminder is stacked on top of it here.
    const results = renderToolResults(flow);
    return resultMarkers.length > 0 ? `${resultMarkers}\n${results}` : results;
  }

  const lastUser = [...conversation].reverse().find((message) => message.role === "user")?.content ?? "";
  return withReminder(lastUser);
}

function renderFullTranscript(conversation: ChatMessage[]): string {
  const userMessages = conversation.filter((message) => message.role === "user");
  const assistantMessages = conversation.filter((message) => message.role === "assistant");
  const toolMessages = conversation.filter((message) => message.role === "tool");
  if (userMessages.length === 1 && assistantMessages.length === 0 && toolMessages.length === 0) {
    return userMessages[0]!.content;
  }

  const lines: string[] = ["<conversation>"];
  for (const message of conversation) {
    if (message.role === "tool") {
      const result = renderToolResultBlocks([message], conversation);
      if (result.length > 0) lines.push(result);
      continue;
    }
    lines.push(message.role === "user" ? "[user]" : "[assistant]");
    if (message.content.length > 0) lines.push(message.content);
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        lines.push(`[function requested: ${call.name} (call ${call.id})]`, call.argumentsJson);
      }
    }
  }
  lines.push("</conversation>", "Continue the conversation. Reply as the assistant to the last user message only.");
  return lines.join("\n");
}

/**
 * Turns the client's message list into the text typed into the Muse composer.
 *
 * A fresh conversation receives the whole transcript (Muse has no composer length limit).
 * A resumed conversation receives only the newest user message, or the latest function
 * results when the client is continuing a function round.
 */
export function renderTranscript(messages: ChatMessage[], opts?: TranscriptOptions): string {
  let systemPrompt: string | undefined;
  let conversation = messages;
  if (messages[0]?.role === "system") {
    systemPrompt = messages[0].content;
    conversation = messages.slice(1);
  }

  if (opts?.resume) return renderResumedTranscript(messages, opts.toolsActive ?? false);

  const prompt = renderFullTranscript(conversation);
  const protocolPrompt = opts?.toolProtocol ? `${opts.toolProtocol}\n\n${prompt}` : prompt;
  if (systemPrompt && systemPrompt.trim().length > 0) {
    return `<system>\n${systemPrompt}\n</system>\n\n${protocolPrompt}`;
  }
  return protocolPrompt;
}
