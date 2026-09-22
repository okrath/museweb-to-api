/**
 * Functions executed inside the muse.ai page through `page.evaluate`. They must stay
 * self-contained: no imports, no closure over module state, only the `args` they receive.
 */

export interface SnapshotArgs {
  root: string[];
  stop: string[];
  composer: string[];
  assistant: string[];
  user: string[];
  strip: string[];
  alerts: string[];
  /** Page chrome that is never the reply (navigation, side panels, toasts). */
  ignore: string[];
  /** Leading part of the prompt, used to recognise the echoed user message. */
  promptHead: string;
}

export interface CandidateSummary {
  tag: string;
  class: string;
  id: string;
  visible: boolean;
  chars: number;
  text: string;
}

export interface PageSnapshot {
  url: string;
  stopVisible: boolean;
  /** innerHTML of the reply subtree, or "" when no reply node exists yet. */
  html: string;
  /** innerText of the reply subtree. */
  text: string;
  /** Stable id of the reply node when the page exposes one (`data-message-id`). */
  targetId: string;
  /** A user message containing the prompt head exists, i.e. the prompt was posted. */
  promptPosted: boolean;
  /** Text under the posted prompt when Muse could not deliver it. */
  deliveryStatus: string;
  freshRoots: number;
  candidates: number;
  /** Every reply candidate this snapshot considered, for calibration. */
  candidateSummaries: CandidateSummary[];
  alerts: string[];
  composerText: string;
}

/** Tags every element under the transcript root so later snapshots can spot inserted nodes. */
export function markSeenScript(args: { root: string[] }): number {
  const root = args.root.map((s) => document.querySelector(s)).find((el): el is Element => Boolean(el)) ?? document.body;
  const elements = root.querySelectorAll("*");
  elements.forEach((el) => el.setAttribute("data-mta-seen", "1"));
  root.setAttribute("data-mta-seen", "1");
  return elements.length;
}

export function snapshotScript(args: SnapshotArgs): PageSnapshot {
  const SEEN = "data-mta-seen";
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  // Screen-reader-only nodes are 1px boxes; anything that small is not a rendered reply.
  const visible = (el: Element) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const query = (list: string[]) => list.flatMap((s) => Array.from(document.querySelectorAll(s)));
  const firstVisible = (list: string[]) => query(list).find(visible);
  const matchesAny = (el: Element, list: string[]) => list.some((s) => el.matches(s));
  const hasUnseen = (el: Element) => !el.hasAttribute(SEEN) || el.querySelector(`:not([${SEEN}])`) !== null;

  const root = args.root.map((s) => document.querySelector(s)).find((el): el is Element => Boolean(el)) ?? document.body;
  const stopVisible = query(args.stop).some(visible);
  const composerEl = firstVisible(args.composer);
  const composerText = composerEl
    ? (composerEl as HTMLTextAreaElement).value ?? (composerEl as HTMLElement).innerText ?? ""
    : "";
  let composerBox: Element | null = composerEl ? composerEl.closest("form") : null;
  if (!composerBox && composerEl) {
    composerBox = composerEl;
    for (let i = 0; i < 4 && composerBox.parentElement && composerBox.parentElement !== root; i++) {
      composerBox = composerBox.parentElement;
    }
  }
  const promptHead = normalize(args.promptHead);
  const echoesPrompt = (el: Element) => promptHead.length > 0 && normalize(el.textContent ?? "").includes(promptHead);
  const isChrome = (el: Element) => matchesAny(el, args.ignore) || args.ignore.some((s) => el.closest(s) !== null && el.closest(s) !== el);

  // Newly inserted subtrees: unseen elements whose parent was already seen (or is the root).
  const fresh: Element[] = [];
  root.querySelectorAll("*").forEach((el) => {
    if (el.hasAttribute(SEEN)) return;
    const parent = el.parentElement;
    if (!parent || parent === root || parent.hasAttribute(SEEN)) fresh.push(el);
  });

  // Descend through wrappers that hold the echoed prompt or the composer together with the reply.
  const leaves = (el: Element, depth: number): Element[] => {
    if (depth > 14 || isChrome(el)) return [];
    if (composerBox && (el === composerBox || composerBox.contains(el))) return [];
    const wrapsComposer = composerBox ? el.contains(composerBox) : false;
    if (!echoesPrompt(el) && !wrapsComposer) return [el];
    return Array.from(el.children).flatMap((child) => leaves(child, depth + 1));
  };

  const userItems = query(args.user);
  const postedItem = [...userItems].reverse().find(echoesPrompt);

  let usable: Element[];
  if (args.assistant.length > 0 && postedItem) {
    // The reply is whatever the assistant said after our own message in transcript order; this
    // also works when the tab navigated to the thread after posting and the reply is already there.
    const after = (el: Element) => (postedItem.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    const explicit = args.assistant.map((s) => Array.from(document.querySelectorAll(s)).filter(after)).find((list) => list.length > 0);
    usable = explicit ?? [];
  } else if (args.assistant.length > 0) {
    const explicit = args.assistant.map((s) => Array.from(document.querySelectorAll(s)).filter(hasUnseen)).find((list) => list.length > 0);
    usable = explicit ?? [];
  } else {
    usable = fresh
      .filter((el) => !isChrome(el))
      .flatMap((el) => leaves(el, 0))
      .filter((el) => normalize(el.textContent ?? "").length > 0);
  }
  const rendered = usable.filter((el) => visible(el) && normalize((el as HTMLElement).innerText ?? "").length > 0);
  const target = rendered[rendered.length - 1] ?? usable[usable.length - 1];

  const candidateSummaries: CandidateSummary[] = usable.slice(-8).map((el) => {
    const text = normalize((el as HTMLElement).innerText ?? el.textContent ?? "");
    return {
      tag: el.tagName.toLowerCase(),
      class: (el.getAttribute("class") ?? "").slice(0, 80),
      id: el.getAttribute("data-message-id") ?? el.getAttribute("data-testid") ?? "",
      visible: visible(el),
      chars: text.length,
      text: text.slice(0, 120),
    };
  });

  let html = "";
  let text = "";
  if (target) {
    const clone = target.cloneNode(true) as Element;
    args.strip.forEach((s) => clone.querySelectorAll(s).forEach((el) => el.remove()));
    html = clone.innerHTML;
    text = (target as HTMLElement).innerText ?? target.textContent ?? "";
  }

  const posted = postedItem ?? userItems.filter(hasUnseen).at(-1);
  const promptPosted = posted !== undefined;
  // Delivery notes render inside (or right after) the user item, outside the bubble text.
  const deliveryStatus = posted
    ? normalize(
        Array.from(posted.querySelectorAll("*"))
          .filter((el) => visible(el) && el.children.length === 0 && !echoesPrompt(el))
          .map((el) => el.textContent ?? "")
          .join(" "),
      ).slice(0, 200)
    : "";

  const alerts = query(args.alerts)
    .filter(visible)
    .map((el) => normalize((el as HTMLElement).innerText ?? "").slice(0, 400))
    .filter((t) => t.length > 0);

  return {
    url: location.href,
    stopVisible,
    html,
    text,
    targetId: target?.getAttribute("data-message-id") ?? "",
    promptPosted,
    deliveryStatus,
    freshRoots: fresh.length,
    candidates: usable.length,
    candidateSummaries,
    alerts,
    composerText,
  };
}

export interface ThreadRow {
  index: number;
  text: string;
  visible: boolean;
}

/** Rows of the side-chat panel in display order (newest side chat first, after "Main chat"). */
export function threadRowsScript(args: { row: string[] }): ThreadRow[] {
  const rows = args.row.map((s) => Array.from(document.querySelectorAll(s))).find((list) => list.length > 0) ?? [];
  return rows.map((el, index) => {
    const rect = el.getBoundingClientRect();
    return {
      index,
      text: ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
      visible: rect.width > 2 && rect.height > 2,
    };
  });
}

/** Visible button/link labels, so the driver can recognise a signed-out landing page. */
export function visibleActionLabelsScript(): string[] {
  const visible = (el: Element) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  return Array.from(document.querySelectorAll("button, a, [role='button']"))
    .filter(visible)
    .map((el) => ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter((text) => text.length > 0 && text.length <= 40);
}

export interface DomReport {
  url: string;
  title: string;
  composers: Array<Record<string, string | boolean | number>>;
  buttons: Array<Record<string, string | boolean>>;
  roots: Array<{ selector: string; found: boolean; children: number }>;
  messages: Array<{ role: string; id: string; text: string }>;
  modeLike: Array<Record<string, string | boolean>>;
}

/** Inventory of the elements the driver cares about, for calibration. */
export function domReportScript(args: { composer: string[]; root: string[]; assistant: string[]; user: string[] }): DomReport {
  const visible = (el: Element) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const describe = (el: Element): Record<string, string | boolean> => ({
    tag: el.tagName.toLowerCase(),
    id: el.id,
    class: el.getAttribute("class") ?? "",
    ariaLabel: el.getAttribute("aria-label") ?? "",
    testId: el.getAttribute("data-testid") ?? "",
    type: el.getAttribute("type") ?? "",
    text: ((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
    visible: visible(el),
    disabled: (el as HTMLButtonElement).disabled === true,
  });
  const composers = args.composer.flatMap((selector) =>
    Array.from(document.querySelectorAll(selector)).map((el) => ({
      selector,
      ...describe(el),
      placeholder: el.getAttribute("placeholder") ?? "",
      contentEditable: el.getAttribute("contenteditable") ?? "",
      role: el.getAttribute("role") ?? "",
    })),
  );
  const buttons = Array.from(document.querySelectorAll("button, [role='button']")).map(describe);
  const roots = args.root.map((selector) => {
    const el = document.querySelector(selector);
    return { selector, found: Boolean(el), children: el ? el.children.length : 0 };
  });
  const messages = [...args.assistant, ...args.user]
    .flatMap((s) => Array.from(document.querySelectorAll(s)))
    .slice(-10)
    .map((el) => ({
      role: el.getAttribute("data-message-role") ?? "",
      id: el.getAttribute("data-message-id") ?? "",
      text: ((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 100),
    }));
  const modeLike = buttons.filter((b) => /instant|thinking|contemplat|mode|model|spark/i.test(`${b.text} ${b.ariaLabel}`));
  return { url: location.href, title: document.title, composers, buttons, roots, messages, modeLike };
}
