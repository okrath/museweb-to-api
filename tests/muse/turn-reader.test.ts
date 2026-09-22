import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../../src/muse/markdown.js";
import { conversationIdFromUrl, isSignedInUrl, newChatUrl } from "../../src/muse/selectors.js";
import { createReaderState, decide, DeltaStreamer, type ReaderTimings } from "../../src/muse/turn-reader.js";
import { renderTranscript } from "../../src/prompt/render-transcript.js";

const timings: ReaderTimings = {
  stableMs: 1000,
  stableWithoutStopMs: 3000,
  firstTokenTimeoutMs: 10_000,
  stallTimeoutMs: 20_000,
  hardTimeoutMs: 100_000,
};

describe("decide", () => {
  it("waits for the first token, then finishes once the stop button is gone and text is quiet", () => {
    const state = createReaderState(0);
    expect(decide(state, { text: "", stopVisible: true }, 500, timings)).toEqual({ kind: "continue" });
    expect(decide(state, { text: "Hel", stopVisible: true }, 1000, timings)).toEqual({ kind: "continue" });
    expect(decide(state, { text: "Hello", stopVisible: true }, 1500, timings)).toEqual({ kind: "continue" });
    expect(decide(state, { text: "Hello", stopVisible: false }, 2000, timings)).toEqual({ kind: "continue" });
    expect(decide(state, { text: "Hello", stopVisible: false }, 2600, timings)).toEqual({ kind: "done" });
  });

  it("needs a longer quiet period when no stop button was ever seen", () => {
    const state = createReaderState(0);
    decide(state, { text: "Hi", stopVisible: false }, 100, timings);
    expect(decide(state, { text: "Hi", stopVisible: false }, 2000, timings)).toEqual({ kind: "continue" });
    expect(decide(state, { text: "Hi", stopVisible: false }, 3200, timings)).toEqual({ kind: "done" });
  });

  it("times out when nothing arrives, when generation stalls, and at the hard limit", () => {
    const empty = createReaderState(0);
    expect(decide(empty, { text: "", stopVisible: false }, 10_000, timings)).toEqual({ kind: "timeout", reason: "no_reply" });

    const stalled = createReaderState(0);
    decide(stalled, { text: "x", stopVisible: true }, 100, timings);
    expect(decide(stalled, { text: "x", stopVisible: true }, 20_200, timings)).toEqual({ kind: "timeout", reason: "stalled" });

    const long = createReaderState(0);
    expect(decide(long, { text: "x", stopVisible: true }, 100_000, timings)).toEqual({ kind: "timeout", reason: "hard_limit" });
  });
});

describe("DeltaStreamer", () => {
  it("streams only completed paragraphs and flushes the rest at the end", () => {
    const streamer = new DeltaStreamer();
    expect(streamer.push("Hello wor")).toBeUndefined();
    expect(streamer.push("Hello world.\n\nSecond para")).toBe("Hello world.\n\n");
    expect(streamer.push("Hello world.\n\nSecond paragraph.\n\nThi")).toBe("Second paragraph.\n\n");
    expect(streamer.finish("Hello world.\n\nSecond paragraph.\n\nThird.")).toBe("Third.");
    expect(streamer.diverged).toBe(false);
  });

  it("stops streaming when a committed paragraph is rewritten and reports the divergence", () => {
    const streamer = new DeltaStreamer();
    streamer.push("Alpha.\n\nBeta");
    expect(streamer.push("Alpha!\n\nBeta gamma")).toBeUndefined();
    expect(streamer.finish("Alpha!\n\nBeta gamma.")).toBe("!\n\nBeta gamma.");
    expect(streamer.diverged).toBe(true);
  });

  it("emits nothing extra when the final text lost only a trailing blank line", () => {
    const streamer = new DeltaStreamer();
    streamer.push("One.\n\nTwo.\n\n");
    expect(streamer.finish("One.\n\nTwo.")).toBe("");
  });
});

describe("htmlToMarkdown", () => {
  it("keeps code fences, lists and emphasis while dropping controls", () => {
    const html =
      '<p>Use <strong>fill</strong>:</p><pre><code class="language-ts">const a = 1;\n</code></pre><ul><li>one</li><li>two</li></ul><button>Copy</button><svg></svg>';
    expect(htmlToMarkdown(html)).toBe("Use **fill**:\n\n```ts\nconst a = 1;\n```\n\n- one\n- two");
  });
});

describe("url helpers", () => {
  it("detects signed-in and auth hosts", () => {
    expect(isSignedInUrl("https://muse.ai/c/123", "https://muse.ai/")).toBe(true);
    expect(isSignedInUrl("https://www.muse.ai/", "https://muse.ai/")).toBe(true);
    expect(isSignedInUrl("https://auth.muse.ai/aymh/?origin=x", "https://muse.ai/")).toBe(false);
    expect(isSignedInUrl("https://www.facebook.com/login", "https://muse.ai/")).toBe(false);
  });

  it("treats only a real side-chat thread as a conversation id", () => {
    expect(conversationIdFromUrl("https://muse.ai/", "https://muse.ai/")).toBeUndefined();
    expect(conversationIdFromUrl("https://muse.ai/thread/new", "https://muse.ai/")).toBeUndefined();
    expect(conversationIdFromUrl("https://muse.ai/thread/abc-123?x=1", "https://muse.ai/")).toBe("https://muse.ai/thread/abc-123");
    expect(newChatUrl("https://muse.ai/")).toBe("https://muse.ai/thread/new");
  });
});

describe("renderTranscript", () => {
  it("sends a lone user message verbatim and wraps multi-turn history", () => {
    expect(renderTranscript([{ role: "user", content: "Hi" }])).toBe("Hi");
    const multi = renderTranscript([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "Next" },
    ]);
    expect(multi).toContain("<system>\nBe brief.\n</system>");
    expect(multi).toContain("<conversation>\n[user]\nHi\n[assistant]\nHello\n[user]\nNext\n</conversation>");
  });

  it("sends only the newest user message when resuming", () => {
    expect(
      renderTranscript(
        [
          { role: "system", content: "s" },
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello" },
          { role: "user", content: "Next" },
        ],
        { resume: true },
      ),
    ).toBe("Next");
  });
});
