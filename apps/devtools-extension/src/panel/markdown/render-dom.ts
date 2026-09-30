import { parseMarkdown } from "./parse.js";
import type { MarkdownBlock, MarkdownInline } from "./types.js";

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function safeHref(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return;
  }
  try {
    const url = new URL(trimmed, "https://example.invalid");
    if (SAFE_LINK_PROTOCOLS.has(url.protocol)) {
      return trimmed;
    }
  } catch {
    // Leave unsafe or malformed URLs as plain text.
  }
}

function appendInlines(parent: HTMLElement, inlines: MarkdownInline[]): void {
  for (const inline of inlines) {
    switch (inline.type) {
      case "text":
        parent.append(document.createTextNode(inline.value));
        break;
      case "code": {
        const code = document.createElement("code");
        code.textContent = inline.value;
        parent.append(code);
        break;
      }
      case "strong": {
        const strong = document.createElement("strong");
        appendInlines(strong, inline.children);
        parent.append(strong);
        break;
      }
      case "em": {
        const em = document.createElement("em");
        appendInlines(em, inline.children);
        parent.append(em);
        break;
      }
      case "link": {
        const href = safeHref(inline.href);
        if (href) {
          const anchor = document.createElement("a");
          anchor.href = href;
          anchor.rel = "noopener noreferrer";
          anchor.target = "_blank";
          appendInlines(anchor, inline.children);
          parent.append(anchor);
        } else {
          appendInlines(parent, inline.children);
        }
        break;
      }
      default:
        break;
    }
  }
}

function renderBlock(block: MarkdownBlock): HTMLElement {
  switch (block.type) {
    case "code": {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (block.language) {
        code.className = `language-${block.language}`;
      }
      code.textContent = block.code;
      pre.append(code);
      return pre;
    }
    case "heading": {
      const heading = document.createElement(`h${block.level}`);
      appendInlines(heading, block.inlines);
      return heading;
    }
    case "list": {
      const list = document.createElement(block.ordered ? "ol" : "ul");
      for (const item of block.items) {
        const li = document.createElement("li");
        appendInlines(li, item);
        list.append(li);
      }
      return list;
    }
    case "paragraph": {
      const paragraph = document.createElement("p");
      appendInlines(paragraph, block.inlines);
      return paragraph;
    }
    case "hr": {
      return document.createElement("hr");
    }
    case "table": {
      const wrap = document.createElement("div");
      wrap.className = "table-wrap";
      const table = document.createElement("table");

      const thead = document.createElement("thead");
      const headerRow = document.createElement("tr");
      for (const cell of block.headers) {
        const th = document.createElement("th");
        appendInlines(th, cell);
        headerRow.append(th);
      }
      thead.append(headerRow);
      table.append(thead);

      const tbody = document.createElement("tbody");
      for (const row of block.rows) {
        const tr = document.createElement("tr");
        for (const cell of row) {
          const td = document.createElement("td");
          appendInlines(td, cell);
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(tbody);
      wrap.append(table);
      return wrap;
    }
    default:
      return document.createElement("p");
  }
}

/**
 * Renders markdown into a DOM subtree using only `createElement` and
 * `textContent` — no `innerHTML`. Swap this module to change or remove
 * markdown rendering in message previews.
 */
export function renderMarkdown(text: string): HTMLElement {
  const root = document.createElement("div");
  root.className = "message-content markdown";

  const blocks = parseMarkdown(text);
  if (blocks.length === 0) {
    root.textContent = text;
    return root;
  }

  for (const block of blocks) {
    root.append(renderBlock(block));
  }
  return root;
}
