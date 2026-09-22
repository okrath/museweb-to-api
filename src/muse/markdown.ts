import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

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
turndown.addRule("fencedCodeWithLanguage", {
  filter: (node) => node.nodeName === "PRE" && node.firstElementChild?.nodeName === "CODE",
  replacement: (_content, node) => {
    const code = (node as HTMLElement).firstElementChild as HTMLElement;
    const className = code.getAttribute("class") ?? "";
    const language = /language-([\w+-]+)/.exec(className)?.[1] ?? "";
    const text = code.textContent ?? "";
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

export function htmlToMarkdown(html: string): string {
  if (!html.trim()) return "";
  return turndown.turndown(html).replace(/\n{3,}/g, "\n\n").trim();
}
