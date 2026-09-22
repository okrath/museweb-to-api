/**
 * Counting semaphore for concurrent browser turns. Callers wait up to the queue timeout
 * for a free slot; a null result means the queue is still full.
 */
export class TurnSlots {
  private active = 0;
  private readonly waiters: Array<(granted: boolean) => void> = [];

  constructor(readonly max: number) {}

  get activeCount(): number {
    return this.active;
  }

  async acquire(timeoutMs: number, signal?: AbortSignal): Promise<(() => void) | null> {
    if (signal?.aborted) return null;
    if (this.active < this.max) {
      this.active++;
      return this.releaser();
    }
    const granted = await new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(value);
      };
      const waiter = (value: boolean) => settle(value);
      const onAbort = () => settle(false);
      const timer = setTimeout(() => settle(false), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
    if (!granted) return null;
    this.active++;
    return this.releaser();
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const next = this.waiters.shift();
      if (next) next(true);
    };
  }
}
