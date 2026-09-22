/**
 * Pure decision logic for reading a Muse reply out of the DOM. Kept free of Playwright so
 * the streaming and completion rules can be unit-tested with plain samples.
 */

export interface ReaderSample {
  /** Plain text of the reply subtree; used for change detection. */
  text: string;
  stopVisible: boolean;
}

export interface ReaderTimings {
  /** Quiet time that ends the turn after a stop button was seen and has disappeared. */
  stableMs: number;
  /** Quiet time that ends the turn when the page never showed a stop button. */
  stableWithoutStopMs: number;
  /** How long to wait for the first character of the reply. */
  firstTokenTimeoutMs: number;
  /** Quiet time while still generating that counts as a hung page. */
  stallTimeoutMs: number;
  /** Absolute ceiling for one turn. */
  hardTimeoutMs: number;
}

export interface ReaderState {
  startedAt: number;
  lastChangeAt: number;
  lastText: string;
  stopSeen: boolean;
}

export type ReaderDecision =
  | { kind: "continue" }
  | { kind: "done" }
  | { kind: "timeout"; reason: "no_reply" | "stalled" | "hard_limit" };

export function createReaderState(now: number): ReaderState {
  return { startedAt: now, lastChangeAt: now, lastText: "", stopSeen: false };
}

export function decide(state: ReaderState, sample: ReaderSample, now: number, timings: ReaderTimings): ReaderDecision {
  if (sample.text !== state.lastText) {
    state.lastText = sample.text;
    state.lastChangeAt = now;
  }
  if (sample.stopVisible) state.stopSeen = true;

  if (now - state.startedAt >= timings.hardTimeoutMs) return { kind: "timeout", reason: "hard_limit" };

  const hasText = state.lastText.trim().length > 0;
  if (!hasText) {
    if (now - state.startedAt >= timings.firstTokenTimeoutMs) return { kind: "timeout", reason: "no_reply" };
    return { kind: "continue" };
  }

  const quietFor = now - state.lastChangeAt;
  if (!sample.stopVisible) {
    const needed = state.stopSeen ? timings.stableMs : timings.stableWithoutStopMs;
    if (quietFor >= needed) return { kind: "done" };
  }
  if (quietFor >= timings.stallTimeoutMs) return { kind: "timeout", reason: "stalled" };
  return { kind: "continue" };
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/**
 * Turns successive Markdown renderings of a growing reply into append-only deltas.
 *
 * Only whole paragraphs are streamed: the tail of a partially rendered reply changes shape
 * while Muse is still typing (an unfinished `**bold` renders differently once closed), and a
 * delta already sent to the client cannot be retracted. If a committed paragraph is later
 * rewritten by the page anyway, streaming pauses and the remainder is emitted at the end.
 */
export class DeltaStreamer {
  private committed = "";
  private divergedFlag = false;

  get diverged(): boolean {
    return this.divergedFlag;
  }

  get sent(): string {
    return this.committed;
  }

  push(markdown: string): string | undefined {
    if (this.divergedFlag) return undefined;
    if (!markdown.startsWith(this.committed)) {
      this.divergedFlag = true;
      return undefined;
    }
    const growth = markdown.slice(this.committed.length);
    const cut = growth.lastIndexOf("\n\n");
    if (cut <= 0) return undefined;
    const delta = growth.slice(0, cut + 2);
    this.committed += delta;
    return delta;
  }

  finish(finalMarkdown: string): string {
    if (this.committed.startsWith(finalMarkdown)) {
      // Nothing beyond what was already sent (or the final rendering lost a trailing blank line).
      this.committed = finalMarkdown;
      return "";
    }
    const prefix = finalMarkdown.startsWith(this.committed)
      ? this.committed.length
      : commonPrefixLength(this.committed, finalMarkdown);
    if (prefix < this.committed.length) this.divergedFlag = true;
    const delta = finalMarkdown.slice(prefix);
    this.committed = finalMarkdown;
    return delta;
  }
}
