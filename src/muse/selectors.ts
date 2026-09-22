import type { MuseMode } from "../core/types.js";

/**
 * Every assumption about the muse.ai DOM lives here. Values were calibrated against the live
 * app on 2026-09-21 with `pnpm muse:probe`; each list is tried in order and the first selector
 * with a visible match wins, so the generic fallbacks after the calibrated entry still help
 * when a class or attribute changes.
 *
 * Muse structure: one "main chat" at `/` plus "side chats" at `/thread/<id>` (`/thread/new`
 * starts one). Messages are `[data-message-item]` with `data-message-role`; the assistant
 * bubble is `[data-hatch-assistant-message-body]`, and every item carries an accessibility
 * transcript `span.sr-only` ("Assistant message: …") holding the raw Markdown.
 */
export const selectors = {
  /** Path (relative to MUSE_URL) that opens a fresh side chat. */
  newChatPath: "/thread/new",
  /** The chat input. */
  composer: ['textarea[aria-label="Message"]', 'textarea[placeholder="Message"]', 'textarea', '[contenteditable="true"][role="textbox"]'],
  /** Appears once the composer holds text; Enter is the fallback. */
  sendButton: ['button[aria-label="Send"]', 'button[aria-label*="send" i]', 'button[data-testid*="send" i]'],
  /** Visible only while Muse is generating. */
  stopButton: ['button[aria-label="Stop"]', 'button[aria-label*="stop" i]', 'button[data-testid*="stop" i]'],
  /** Container that holds the transcript; new nodes appearing under it are the reply. */
  conversationRoot: ['[class*="chat-feed"]', 'main', '[role="main"]', 'body'],
  /** Assistant message items; the reader takes the last one inserted after sending. */
  assistantMessage: ['[data-message-item][data-message-role="assistant"]', '[data-hatch-assistant-message-body]'],
  /** User message items, used to confirm the prompt was posted and to spot delivery failures. */
  userMessage: ['[data-message-item][data-message-role="user"]'],
  /** Removed from the reply subtree before it is converted to Markdown. */
  strip: ['button', 'svg', '[role="toolbar"]', '[aria-live]', '.sr-only'],
  /** Page chrome that can change during a turn but is never the reply. */
  ignore: [
    'nav',
    'aside',
    'header',
    'footer',
    '[role="alert"]',
    '[role="status"]',
    '[role="dialog"]',
    '[role="navigation"]',
    '[data-testid^="hatch-nav"]',
    '[data-testid^="hatch-status"]',
    '[data-testid^="hatch-dock"]',
    '[data-testid^="hatch-side-chats"]',
    '[data-testid="hatch-composer-placeholder-overlay"]',
  ],
  /** Opens the response-mode picker (Instant / Thinking / Contemplating). Not yet seen on the web UI. */
  modeMenuButton: [
    'button[aria-label*="mode" i]',
    'button[aria-label*="model" i]',
    'button[aria-haspopup="menu"]',
    'button[aria-haspopup="listbox"]',
  ],
  modeMenu: ['[role="menu"]', '[role="listbox"]', '[role="dialog"]'],
  modeOption: ['[role="menuitem"]', '[role="menuitemradio"]', '[role="option"]', 'button', 'li'],
  /** Visible surfaces that may carry an error, quota or delivery message. */
  alerts: ['[role="alert"]', '[role="dialog"]', '[role="status"]', '[aria-live]'],
  /**
   * Side-chat panel. `/thread/new` never re-routes to the thread it creates, so after posting
   * the driver watches this panel for the new row (newest first, below "Main chat") and clicks it.
   */
  threadPanel: ['[data-testid="hatch-side-chats-panel-shell"]'],
  threadPanelTrigger: ['[data-testid="hatch-chat-switcher-trigger"]'],
  threadRow: ['[data-testid="hatch-thread-row"]'],
  /** Per-row "..." trigger; only rendered on hover/focus of its row (Pin/Rename/Archive/Delete). */
  threadRowMenuButton: ['button[aria-label="More thread actions"]'],
  /** Confirmation dialog shown after choosing Delete from that menu. */
  threadDeleteConfirmDialog: ['[role="alertdialog"]', '[role="dialog"]'],
};

export const mainChatRowPattern = /^main chat\b/i;
export const threadUrlPattern = /\/thread\/(?!new$)[^/?#]+/;
/** Matches both the "Delete" menu item and the "Delete" button inside its confirm dialog. */
export const threadDeleteItemPattern = /^delete$/i;
/** Identifies the confirm dialog among other dialogs by its own text. */
export const threadDeleteConfirmPattern = /delete/i;

export const modeLabels: Record<Exclude<MuseMode, "default">, RegExp> = {
  instant: /instant/i,
  thinking: /thinking/i,
  contemplating: /contemplat/i,
};

export const rateLimitPattern = /rate limit|limit reached|too many|try again (later|in)|slow down|quota|usage cap/i;
export const upstreamErrorPattern = /something went wrong|couldn.t (generate|respond|complete)|network error|unavailable/i;
/** Muse shows these under the user bubble when its agent VM did not accept the message. */
export const deliveryFailurePattern = /message failed to send|delivery not confirmed/i;

/** Hosts the page lands on when the browser profile is not signed in. */
export const authHostPattern = /(^|\.)auth\.muse\.ai$|(^|\.)facebook\.com$|(^|\.)accountscenter\./i;

/**
 * Signed out, muse.ai bounces through auth.muse.ai and lands back on its own landing page
 * (no composer, a visible "Log in" button and a phone-number form). Visible buttons or links
 * whose text matches this pattern identify that state.
 */
export const signedOutButtonPattern = /^(log ?in|sign ?in|sign ?up|continue with|get started)\b/i;

export function isSignedInUrl(pageUrl: string, museUrl: string): boolean {
  let host: string;
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    return false;
  }
  if (authHostPattern.test(host)) return false;
  const expected = new URL(museUrl).hostname.replace(/^www\./, "");
  const actual = host.replace(/^www\./, "");
  return actual === expected || actual.endsWith(`.${expected}`);
}

export function newChatUrl(museUrl: string): string {
  return new URL(selectors.newChatPath, museUrl).toString();
}

/**
 * A conversation id is the side-chat URL (`/thread/<id>`). The main chat (`/`) and the draft
 * route (`/thread/new`) have no id: the former is shared with the user's own chatting, the
 * latter only becomes a real thread once Muse has answered.
 */
export function conversationIdFromUrl(pageUrl: string, museUrl: string): string | undefined {
  try {
    const page = new URL(pageUrl);
    const home = new URL(museUrl);
    if (page.hostname !== home.hostname) return undefined;
    const path = page.pathname.replace(/\/+$/, "");
    if (!threadUrlPattern.test(path)) return undefined;
    return `${page.origin}${path}`;
  } catch {
    return undefined;
  }
}
