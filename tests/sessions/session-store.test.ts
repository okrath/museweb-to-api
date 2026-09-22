import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cacheKey, ResponseCache } from "../../src/cache/response-cache.js";
import { fingerprint, lookupFingerprint, SessionStore } from "../../src/sessions/session-store.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mta-store-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("fingerprints", () => {
  it("ignores surrounding whitespace but not the conversation hint", () => {
    const a = fingerprint("h", [{ role: "user", content: "hi " }]);
    const b = fingerprint("h", [{ role: "user", content: "hi" }]);
    const c = fingerprint("other", [{ role: "user", content: "hi" }]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("looks up follow-ups whose newest message is from the user or a tool result", () => {
    expect(lookupFingerprint(undefined, [{ role: "user", content: "hi" }])).toBeNull();
    expect(
      lookupFingerprint(undefined, [
        { role: "system", content: "s" },
        { role: "user", content: "hi" },
      ]),
    ).toBeNull();
    const history = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
    ];
    expect(lookupFingerprint(undefined, [...history, { role: "user", content: "again" }])).toBe(
      fingerprint(undefined, history),
    );
    const toolHistory = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "", toolCalls: [{ id: "call_1", name: "f", argumentsJson: "{}" }] },
    ];
    expect(
      lookupFingerprint(undefined, [
        ...toolHistory,
        { role: "tool", content: "result", toolCallId: "call_1" },
      ]),
    ).toBe(fingerprint(undefined, toolHistory));
    expect(
      lookupFingerprint(undefined, [
        ...toolHistory,
        { role: "tool", content: "result", toolCallId: "call_1" },
        { role: "user", content: "next" },
      ]),
    ).toBe(fingerprint(undefined, toolHistory));
  });
});

describe("SessionStore", () => {
  it("persists rows across instances and expires them", () => {
    const path = join(tempDir(), "sessions.json");
    const store = new SessionStore(path);
    store.replace(null, {
      fingerprint: "fp1",
      conversationId: "https://muse.ai/c/1",
      mode: "default",
      turns: 1,
      lastUsedAt: 1000,
      expiresAt: 5000,
    });
    store.flush();

    const reopened = new SessionStore(path);
    expect(reopened.find("fp1", 2000)?.conversationId).toBe("https://muse.ai/c/1");
    expect(reopened.find("fp1", 6000)).toBeUndefined();
  });

  it("moves a conversation from the old fingerprint to the new one", () => {
    const store = new SessionStore(join(tempDir(), "sessions.json"));
    const row = { conversationId: "c", mode: "default" as const, turns: 1, lastUsedAt: 0, expiresAt: 10 };
    store.replace(null, { fingerprint: "old", ...row });
    store.replace("old", { fingerprint: "new", ...row, turns: 2 });
    expect(store.find("old", 1)).toBeUndefined();
    expect(store.find("new", 1)?.turns).toBe(2);
  });
});

describe("ResponseCache", () => {
  it("returns a body until it expires and keys on model, mode, max tokens and messages", () => {
    const cache = new ResponseCache(join(tempDir(), "cache.json"));
    const messages = [{ role: "user" as const, content: "hi" }];
    const key = cacheKey("muse", "default", undefined, messages);
    expect(key).not.toBe(cacheKey("muse", "thinking", undefined, messages));
    expect(key).not.toBe(cacheKey("muse", "default", 10, messages));
    cache.set(key, { text: "hello", thinking: "" }, 10, 1000);
    expect(cache.get(key, 5000)?.text).toBe("hello");
    expect(cache.get(key, 12_000)).toBeNull();
  });

  it("changes identity when the function definitions change", () => {
    const messages = [{ role: "user" as const, content: "hi" }];
    const a = [{ name: "f", parameters: { type: "object" } }];
    const b = [{ name: "f", parameters: { type: "object", properties: { x: { type: "string" } } } }];
    expect(fingerprint(undefined, messages, a)).not.toBe(fingerprint(undefined, messages, b));
    expect(cacheKey("muse", "default", undefined, messages, a)).not.toBe(cacheKey("muse", "default", undefined, messages, b));
  });
});
