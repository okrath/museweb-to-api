import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { codeLineClass, keyValueGridClass } from "./selectors.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  fence: "```",
  emDelimiter: "*",
  strongDelimiter: "**",
  linkStyle: "inlined",
});

turndown.use(gfm);
turndown.remove(["button", "script", "style"]);
turndown.addRule("dropImages", {
  filter: (node) => ["IMG", "PICTURE", "SOURCE", "SVG"].includes(node.nodeName),
  replacement: () => "",
});
turndown.addRule("keyValueGrid", {
  filter: (node) => keyValueRows(node) !== null,
  replacement: (_content, node) => {
    const lines = keyValueRows(node)!.map(([label, value]) => `${label.textContent?.trim()}: ${value.textContent?.trim()}`);
    return `\n\n${lines.join("\n")}\n\n`;
  },
});
turndown.addRule("fencedCodeWithLanguage", {
  filter: (node) => node.nodeName === "PRE" && node.firstElementChild?.nodeName === "CODE",
  replacement: (_content, node) => {
    const code = (node as HTMLElement).firstElementChild as HTMLElement;
    const classNames = `${code.getAttribute("class") ?? ""} ${(node as HTMLElement).getAttribute("class") ?? ""}`;
    const language = /language-([\w+-]+)/.exec(classNames)?.[1] ?? "";
    const text = codeText(code);
    return `\n\n\`\`\`${language}\n${text.replace(/\n$/, "")}\n\`\`\`\n\n`;
  },
});
turndown.addRule("compactListItem", {
  filter: "li",
  replacement: (content, node, options) => {
    const parent = node.parentNode as HTMLElement | null;
    let prefix = `${options.bulletListMarker} `;
    if (parent?.nodeName === "OL") {
      const start = Number(parent.getAttribute("start") ?? "1");
      const index = Array.prototype.indexOf.call(parent.children, node) as number;
      prefix = `${start + index}. `;
    }
    const normalized = content.replace(/^\n+|\n+$/g, "").replace(/\n/g, `\n${" ".repeat(prefix.length)}`);
    return `${prefix}${normalized}${node.nextSibling ? "\n" : ""}`;
  },
});

function hasClass(node: Node, className: string): boolean {
  return ((node as HTMLElement).getAttribute?.("class") ?? "").split(/\s+/).includes(className);
}

/** The label/value pairs of Muse's key-value grid, or null when `node` is not one. */
function keyValueRows(node: HTMLElement): [Element, Element][] | null {
  if (node.nodeName !== "DIV" || !hasClass(node, keyValueGridClass)) return null;
  const rows = Array.from(node.children);
  if (rows.length === 0 || rows.some((row) => row.children.length !== 2)) return null;
  return rows.map((row) => [row.children[0]!, row.children[1]!]);
}

/** Code text with its line breaks, also when every line is its own element without a "\n". */
function codeText(code: HTMLElement): string {
  const lines = Array.from(code.childNodes).filter((node) => node.nodeType !== 3 || node.textContent?.trim());
  const isLine = (node: ChildNode) => node.nodeName === "SPAN" && hasClass(node, codeLineClass);
  if (lines.length === 0 || !lines.every(isLine)) return code.textContent ?? "";
  return lines.map((line) => line.textContent ?? "").join("\n");
}

export function htmlToMarkdown(html: string): string {
  if (!html.trim()) return "";
  return turndown.turndown(html).replace(/\n{3,}/g, "\n\n").trim();
}
