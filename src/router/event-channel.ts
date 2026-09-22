import type { TurnEvent } from "../core/types.js";

/** Bridges a callback-style emitter into an async iterable the HTTP layer can consume. */
export function createEventChannel(): {
  emit: (event: TurnEvent) => void;
  close: () => void;
  fail: (err: unknown) => void;
  events: AsyncIterable<TurnEvent>;
} {
  const queue: TurnEvent[] = [];
  let closed = false;
  let failure: unknown;
  let wake: (() => void) | null = null;

  const notify = () => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };

  const events: AsyncIterable<TurnEvent> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (failure !== undefined) throw failure;
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };

  return {
    emit(event) {
      if (closed) return;
      queue.push(event);
      notify();
    },
    close() {
      closed = true;
      notify();
    },
    fail(err) {
      failure = err ?? new Error("turn failed");
      closed = true;
      notify();
    },
    events,
  };
}
