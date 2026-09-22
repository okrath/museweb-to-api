import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Small persistent map backed by one JSON file. Writes are debounced and atomic
 * (write a sibling temp file, then rename) so a crash never leaves a half-written file.
 */
export class JsonStore<T> {
  private readonly entries = new Map<string, T>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly path: string,
    private readonly debounceMs = 500,
  ) {
    this.load();
  }

  get(key: string): T | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: T): void {
    this.entries.set(key, value);
    this.schedule();
  }

  delete(key: string): boolean {
    const removed = this.entries.delete(key);
    if (removed) this.schedule();
    return removed;
  }

  values(): T[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }

  /** Removes every entry the predicate rejects; returns how many were removed. */
  prune(keep: (value: T, key: string) => boolean): number {
    let removed = 0;
    for (const [key, value] of this.entries) {
      if (!keep(value, key)) {
        this.entries.delete(key);
        removed++;
      }
    }
    if (removed > 0) this.schedule();
    return removed;
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, entries: [...this.entries.entries()] }), {
      mode: 0o600,
    });
    renameSync(tmp, this.path);
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.flush();
      } catch {
        /* recoverable state only; a failed write must not fail a turn */
      }
    }, this.debounceMs);
    this.timer.unref?.();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as { version?: number; entries?: unknown };
      if (raw.version !== 1 || !Array.isArray(raw.entries)) return;
      for (const entry of raw.entries) {
        if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string") {
          this.entries.set(entry[0], entry[1] as T);
        }
      }
    } catch {
      /* corrupt file: start empty */
    }
  }
}
