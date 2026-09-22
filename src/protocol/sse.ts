import type { ServerResponse } from "node:http";

type ReplyHeaderValue = string | number | string[] | undefined;

// Streaming responses bypass Fastify's reply (`reply.hijack()`), so anything a
// plugin put on the reply — notably @fastify/cors's Access-Control-Allow-Origin —
// must be carried over explicitly or browsers refuse to read the stream.
export function setStreamHeaders(raw: ServerResponse, headers: Record<string, ReplyHeaderValue>): void {
  const carried: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    carried[name] = Array.isArray(value) ? value : String(value);
  }
  raw.writeHead(200, {
    ...carried,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

export function writeFrame(raw: ServerResponse, data: string, event?: string): void {
  if (event !== undefined) raw.write(`event: ${event}\n`);
  raw.write(`data: ${data}\n\n`);
}

export function writeComment(raw: ServerResponse, text: string): void {
  raw.write(`: ${text}\n\n`);
}

export function startHeartbeat(intervalMs: number, onTick: () => void): { stop: () => void } {
  const timer = setInterval(onTick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
