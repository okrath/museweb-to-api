import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import {
  computeMedian,
  consumeTabReload,
  noteTabSnapshot,
  reloadSlowPage,
  type TabReloadState,
} from "../../src/muse/browser.js";
import { selectors } from "../../src/muse/selectors.js";

describe("computeMedian", () => {
  it("returns undefined for empty samples", () => {
    expect(computeMedian([])).toBeUndefined();
  });

  it("returns the sole element for a single sample", () => {
    expect(computeMedian([42])).toBe(42);
  });

  it("calculates the median for an odd number of samples without requiring sorted input", () => {
    expect(computeMedian([300, 100, 200])).toBe(200);
    expect(computeMedian([50, 10, 40, 20, 30])).toBe(30);
  });

  it("calculates the median for an even number of samples with rounding", () => {
    expect(computeMedian([100, 200, 300, 400])).toBe(250);
    expect(computeMedian([100, 201])).toBe(151);
  });

  it("does not mutate the input array", () => {
    const input = [300, 100, 200];
    computeMedian(input);
    expect(input).toEqual([300, 100, 200]);
  });
});

describe("noteTabSnapshot and consumeTabReload", () => {
  it("does not flag tab when snapshot is under or at threshold", () => {
    const state: TabReloadState = { needsReload: false };

    expect(noteTabSnapshot(state, 1200, 1500)).toBe(false);
    expect(state.needsReload).toBe(false);
    expect(state.slowSnapshotMs).toBeUndefined();

    expect(noteTabSnapshot(state, 1500, 1500)).toBe(false);
    expect(state.needsReload).toBe(false);
    expect(state.slowSnapshotMs).toBeUndefined();
  });

  it("flags tab when snapshot is over threshold", () => {
    const state: TabReloadState = { needsReload: false };

    expect(noteTabSnapshot(state, 1501, 1500)).toBe(true);
    expect(state.needsReload).toBe(true);
    expect(state.slowSnapshotMs).toBe(1501);
  });

  it("consumes reload once and clears the flag", () => {
    const state: TabReloadState = { needsReload: true, slowSnapshotMs: 2200 };

    const first = consumeTabReload(state);
    expect(first).toEqual({ shouldReload: true, slowSnapshotMs: 2200 });
    expect(state.needsReload).toBe(false);
    expect(state.slowSnapshotMs).toBeUndefined();

    const second = consumeTabReload(state);
    expect(second).toEqual({ shouldReload: false });
  });

  it("handles unflagged state in consumeTabReload", () => {
    const state: TabReloadState = { needsReload: false };
    expect(consumeTabReload(state)).toEqual({ shouldReload: false });
  });

  it("simulates tab lifecycle: marked over threshold is reloaded once on next acquire, then cleared", () => {
    const tabState: TabReloadState = { needsReload: false };

    // Turn 1: healthy read
    noteTabSnapshot(tabState, 350, 1500);
    expect(consumeTabReload(tabState)).toEqual({ shouldReload: false });

    // Turn 2: slow read crosses threshold
    noteTabSnapshot(tabState, 1850, 1500);
    expect(tabState.needsReload).toBe(true);
    expect(tabState.slowSnapshotMs).toBe(1850);

    // Next acquire: tab is reloaded and cleared
    const reload = consumeTabReload(tabState);
    expect(reload).toEqual({ shouldReload: true, slowSnapshotMs: 1850 });
    expect(tabState.needsReload).toBe(false);

    // Follow-up acquire: not reloaded again
    expect(consumeTabReload(tabState)).toEqual({ shouldReload: false });
  });
});

describe("reloadSlowPage", () => {
  it("reloads the page and waits for composer", async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    const waitFor = vi.fn().mockResolvedValue(undefined);
    const locator = vi.fn().mockReturnValue({ first: () => ({ waitFor }) });
    const logInfo = vi.fn();

    const fakePage = {
      url: () => "https://muse.ai/thread/test-1",
      isClosed: () => false,
      reload,
      locator,
    } as unknown as Page;

    await reloadSlowPage(fakePage, { info: logInfo }, 1800);

    expect(logInfo).toHaveBeenCalledWith(
      { url: "https://muse.ai/thread/test-1", snapshotMs: 1800 },
      "Reloading slow tab before turn",
    );
    expect(reload).toHaveBeenCalledWith({ waitUntil: "domcontentloaded" });
    expect(locator).toHaveBeenCalledWith(selectors.composer.join(", "));
    expect(waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 20_000 });
  });

  it("skips reload if the page is closed", async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    const logInfo = vi.fn();

    const fakePage = {
      url: () => "https://muse.ai/thread/test-closed",
      isClosed: () => true,
      reload,
    } as unknown as Page;

    await reloadSlowPage(fakePage, { info: logInfo }, 1800);

    expect(reload).not.toHaveBeenCalled();
  });
});
