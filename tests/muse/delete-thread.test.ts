import { describe, expect, it } from "vitest";
import { isThreadDeleted } from "../../src/muse/thread-cleanup.js";
import { FakeDriver } from "../helpers/fake-driver.js";

const museUrl = "https://muse.ai/";
const targetUrl = "https://muse.ai/thread/abc-123";

describe("isThreadDeleted", () => {
  it("is deleted when the reload redirected away from the thread", () => {
    expect(isThreadDeleted({ currentUrl: "https://muse.ai/", targetUrl, museUrl, activeRowPresent: true })).toBe(true);
    expect(isThreadDeleted({ currentUrl: "https://muse.ai/thread/other", targetUrl, museUrl, activeRowPresent: true })).toBe(true);
  });

  it("is deleted when the reload stays on the URL but no panel row is the open thread", () => {
    expect(isThreadDeleted({ currentUrl: targetUrl, targetUrl, museUrl, activeRowPresent: false })).toBe(true);
  });

  it("is still present when the reload stays on the URL and the panel marks it open", () => {
    expect(isThreadDeleted({ currentUrl: targetUrl, targetUrl, museUrl, activeRowPresent: true })).toBe(false);
    expect(isThreadDeleted({ currentUrl: `${targetUrl}/`, targetUrl, museUrl, activeRowPresent: true })).toBe(false);
  });
});

describe("FakeDriver.deleteThread", () => {
  it("records deletions and can be scripted to fail", async () => {
    const driver = new FakeDriver();
    await driver.deleteThread(targetUrl);
    driver.setDeleteError(new Error("Muse refused"));
    await expect(driver.deleteThread("https://muse.ai/thread/fail")).rejects.toThrow("Muse refused");
    driver.setDeleteError(undefined);
    await driver.deleteThread("https://muse.ai/thread/ok");
    expect(driver.deletedThreads).toEqual([targetUrl, "https://muse.ai/thread/ok"]);
  });
});
