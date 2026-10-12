import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import type { Attachment, MuseMode } from "../core/types.js";
import {
  type DriverContext,
  firstExisting,
  firstVisible,
  normalizeText,
  POLL_MS,
  sameUrl,
  sleep,
  TurnError,
  waitForComposer,
} from "./page-context.js";
import type { PageSnapshot } from "./page-scripts.js";
import { conversationIdFromUrl, modeLabels, newChatUrl, selectors } from "./selectors.js";

/** Everything done in the composer before a reply is read: open, mode, prompt, files, send. */
const SUBMIT_CONFIRM_MS = 8_000;
const MODE_OPTION_WAIT_MS = 1_500;
/** How long to wait for an attached file to show an upload preview before sending anyway. */
const ATTACHMENT_UPLOAD_WAIT_MS = 20_000;

async function composerText(composer: Locator): Promise<string> {
  return composer.evaluate((el) => {
    const input = el as HTMLTextAreaElement;
    return typeof input.value === "string" ? input.value : ((el as HTMLElement).innerText ?? el.textContent ?? "");
  });
}

function acceptedPrompt(observed: string, prompt: string): boolean {
  const seen = normalizeText(observed);
  const want = normalizeText(prompt);
  if (seen === want) return true;
  if (want.length === 0) return seen.length === 0;
  const ratio = seen.length / want.length;
  return ratio >= 0.98 && ratio <= 1.02 && seen.slice(0, 40) === want.slice(0, 40);
}

export async function openConversation(page: Page, ctx: DriverContext, conversationId: string | undefined): Promise<Locator> {
  // A new API conversation always gets its own Muse side chat, never the user's main chat.
  const target = conversationId ?? newChatUrl(ctx.config.museUrl);
  if (!conversationId || !sameUrl(page.url(), target)) {
    await page.goto(target, { waitUntil: "domcontentloaded" });
  }
  const composer = await waitForComposer(page, ctx.config.museUrl);
  if (conversationId) {
    const landed = conversationIdFromUrl(page.url(), ctx.config.museUrl);
    if (!landed || !sameUrl(landed, conversationId)) {
      throw new TurnError("browser", `Muse conversation ${conversationId} is no longer reachable (page is at ${page.url()})`);
    }
  }
  return composer;
}

async function labelOf(locator: Locator): Promise<string> {
  return locator.evaluate((el) => `${(el as HTMLElement).innerText ?? ""} ${el.getAttribute("aria-label") ?? ""}`);
}

export async function selectMode(page: Page, mode: MuseMode, ctx: DriverContext): Promise<void> {
  if (mode === "default") return;
  const wanted = modeLabels[mode];
  const anyMode = /instant|thinking|contemplat/i;

  const buttons: Locator[] = [];
  for (const selector of selectors.modeMenuButton) {
    const matches = page.locator(selector).filter({ visible: true });
    const count = await matches.count().catch(() => 0);
    for (let i = 0; i < count && buttons.length < 8; i++) buttons.push(matches.nth(i));
  }
  const labelled = await Promise.all(buttons.map(async (button) => ({ button, label: await labelOf(button).catch(() => "") })));
  labelled.sort((a, b) => Number(anyMode.test(b.label)) - Number(anyMode.test(a.label)));

  for (const { button, label } of labelled.slice(0, 6)) {
    if (wanted.test(label)) return;
    await button.click().catch(() => undefined);
    const option = page.locator(selectors.modeOption.join(","), { hasText: wanted }).filter({ visible: true }).first();
    const found = await option.waitFor({ state: "visible", timeout: MODE_OPTION_WAIT_MS }).then(() => true, () => false);
    if (found) {
      await option.click();
      await sleep(300);
      ctx.log.debug({ mode }, "Muse mode selected");
      return;
    }
    await page.keyboard.press("Escape").catch(() => undefined);
  }
  throw new TurnError(
    "browser",
    `Muse mode "${mode}" could not be selected; run "pnpm muse:probe" and update modeMenuButton/modeOption in src/muse/selectors.ts, or use model "muse"`,
  );
}

async function typePromptOnce(page: Page, composer: Locator, prompt: string): Promise<void> {
  await composer.click();
  await composer.fill(prompt).catch(() => undefined);
  if (acceptedPrompt(await composerText(composer), prompt)) return;

  await composer.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(prompt);
  const observed = await composerText(composer);
  if (!acceptedPrompt(observed, prompt)) {
    throw new TurnError(
      "browser",
      `Muse composer did not accept the full prompt (expected ${prompt.length} chars, saw ${observed.length})`,
    );
  }
}

/**
 * Right after an attachment's preview renders, the composer can be transiently unstable
 * (layout reflow makes it briefly not actionable), which fails `composer.evaluate()` with the
 * context's 20 s action timeout. One retry after a short pause absorbs that without masking a
 * real failure (a composer that stays broken still throws on the second attempt).
 */
export async function typePrompt(page: Page, composer: Locator, prompt: string): Promise<void> {
  try {
    await typePromptOnce(page, composer, prompt);
  } catch {
    await sleep(500);
    await typePromptOnce(page, composer, prompt);
  }
}

/**
 * Writes every attachment to a temp file and hands them to the composer's file input via
 * `setInputFiles` (works on a hidden input, so no "attach" button needs to be clicked first).
 * Returns a cleanup that removes the temp directory; on failure it cleans up and rethrows.
 */
export async function attachFiles(page: Page, attachments: Attachment[], ctx: DriverContext): Promise<() => Promise<void>> {
  const dir = await mkdtemp(join(tmpdir(), "mta-attach-"));
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => undefined);
  try {
    const paths = await Promise.all(
      attachments.map(async (attachment, index) => {
        const safeName = attachment.filename.replace(/[\\/:*?"<>|]/g, "_") || `attachment-${index}`;
        const path = join(dir, `${index}-${safeName}`);
        await writeFile(path, Buffer.from(attachment.data, "base64"));
        return path;
      }),
    );
    const input = await firstExisting(page, selectors.fileInput);
    if (!input) {
      throw new TurnError(
        "browser",
        'Muse file input not found; run "pnpm muse:probe" and update selectors.fileInput in src/muse/selectors.ts',
      );
    }
    await input.setInputFiles(paths);

    const preview = page.locator(selectors.attachmentPreview.join(",")).filter({ visible: true });
    const deadline = Date.now() + ATTACHMENT_UPLOAD_WAIT_MS;
    while (Date.now() < deadline && (await preview.count().catch(() => 0)) === 0) {
      await sleep(POLL_MS);
    }
    if ((await preview.count().catch(() => 0)) === 0) {
      ctx.log.warn("No visible attachment preview appeared after setInputFiles; sending anyway");
    }
    return cleanup;
  } catch (err) {
    await cleanup();
    throw err;
  }
}

export async function submit(page: Page, composer: Locator, snapshot: () => Promise<PageSnapshot>, ctx: DriverContext): Promise<void> {
  const send = await firstVisible(page, selectors.sendButton);
  const enabled = send ? await send.isEnabled().catch(() => false) : false;
  if (send && enabled) await send.click();
  else await composer.press("Enter");

  const deadline = Date.now() + SUBMIT_CONFIRM_MS;
  while (Date.now() < deadline) {
    const snap = await snapshot();
    if (snap.stopVisible || snap.candidates > 0 || normalizeText(snap.composerText).length === 0) return;
    await sleep(POLL_MS);
  }
  ctx.log.warn("Muse composer still holds the prompt after sending; waiting for a reply anyway");
}
