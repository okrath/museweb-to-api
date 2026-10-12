import { describe, expect, it } from "vitest";
import { promptTailKey } from "../../src/muse/page-scripts.js";

// The snapshot script applies the same reduction to each user message before looking for the key.
const reduce = (text: string) => text.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();

describe("prompt tail key", () => {
  const system = `<system>\nYou are a coding assistant.\n${"Use the endpoints below. ".repeat(200)}</system>\n\n`;
  const idle = `${system}Find the default of SIDE_THREAD_IDLE_SEC in src/config.ts.\nReturn JSON {"value": <number>}.`;
  const reaper = `${system}Count how many it( test cases tests/router/thread-reaper.test.ts contains.\nReturn JSON {"value": <number>} with the count.`;

  it("tells apart prompts that share their head", () => {
    expect(idle.slice(0, 120)).toBe(reaper.slice(0, 120));
    expect(promptTailKey(idle)).not.toBe(promptTailKey(reaper));
    expect(reduce(`User message: ${reaper}`)).not.toContain(promptTailKey(idle));
  });

  it("is found in the rendered message however spacing and punctuation come out", () => {
    const rendered = `User message: ${idle.replace(/\n/g, " ").replace(/`/g, "")}`;
    expect(reduce(rendered)).toContain(promptTailKey(idle));
    expect(promptTailKey("Session start. Reply with exactly: Ready.")).toBe("sessionstartreplywithexactlyready");
  });
});
