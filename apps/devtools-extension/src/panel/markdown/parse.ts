import type { HeadingLevel, MarkdownBlock, MarkdownInline } from "./types.js";

const FENCE_OPEN = /^```([\w-]*)?\s*$/;
const FENCE_CLOSE = /^```\s*$/;
const HEADING = /^(#{1,6})\s+(.+)$/;
const HORIZONTAL_RULE = /^(-{3,}|\*{3,}|_{3,})\s*$/;
const UNORDERED_LIST = /^[-*+]\s+(.+)$/;
const ORDERED_LIST = /^\d+\.\s+(.+)$/;
const TABLE_SEPARATOR_CELL = /^:?-{1,}:?$/;

function readLinkDestination(
  text: string,
  openParen: number
): { end: number; href: string } | undefined {
  if (text[openParen] !== "(") {
    return;
  }
  let depth = 0;
  for (let cursor = openParen; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return { end: cursor, href: text.slice(openParen + 1, cursor) };
      }
    }
  }
}

function mergeAdjacentText(inlines: MarkdownInline[]): MarkdownInline[] {
  const merged: MarkdownInline[] = [];
  for (const inline of inlines) {
    const last = merged.at(-1);
    if (inline.type === "text" && last?.type === "text") {
      last.value += inline.value;
      continue;
    }
    merged.push(inline);
  }
  return merged;
}

function nextSpecialIndex(text: string, start: number): number {
  let cursor = start + 1;
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === "`" || char === "*" || char === "[") {
      break;
    }
    cursor += 1;
  }
  return cursor;
}

function parseInlineAt(
  text: string,
  index: number
): { inline: MarkdownInline; next: number } | undefined {
  if (text[index] === "`") {
    const end = text.indexOf("`", index + 1);
    if (end !== -1) {
      return {
        inline: { type: "code", value: text.slice(index + 1, end) },
        next: end + 1,
      };
    }
  }

  if (text.startsWith("**", index)) {
    const end = text.indexOf("**", index + 2);
    if (end !== -1) {
      return {
        inline: {
          children: parseInlines(text.slice(index + 2, end)),
          type: "strong",
        },
        next: end + 2,
      };
    }
  }

  if (text[index] === "*" && text[index + 1] !== "*") {
    const end = text.indexOf("*", index + 1);
    if (end !== -1 && text[end + 1] !== "*") {
      return {
        inline: {
          children: parseInlines(text.slice(index + 1, end)),
          type: "em",
        },
        next: end + 1,
      };
    }
  }

  if (text[index] === "[") {
    const closeBracket = text.indexOf("]", index + 1);
    if (closeBracket !== -1) {
      const destination = readLinkDestination(text, closeBracket + 1);
      if (destination) {
        return {
          inline: {
            children: parseInlines(text.slice(index + 1, closeBracket)),
            href: destination.href,
            type: "link",
          },
          next: destination.end + 1,
        };
      }
    }
  }

  const next = nextSpecialIndex(text, index);
  return {
    inline: { type: "text", value: text.slice(index, next) },
    next,
  };
}

/** Parses inline markdown into a safe AST (no HTML passthrough). */
export function parseInlines(text: string): MarkdownInline[] {
  const result: MarkdownInline[] = [];
  let index = 0;

  while (index < text.length) {
    const parsed = parseInlineAt(text, index);
    if (!parsed) {
      break;
    }
    result.push(parsed.inline);
    index = parsed.next;
  }

  return mergeAdjacentText(result);
}

function splitTableCells(line: string): string[] {
  let inner = line.trim();
  if (inner.startsWith("|")) {
    inner = inner.slice(1);
  }
  if (inner.endsWith("|")) {
    inner = inner.slice(0, -1);
  }
  return inner.split("|").map((cell) => cell.trim());
}

function isTableRow(line: string): boolean {
  return line.includes("|") && splitTableCells(line).length > 0;
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableCells(line);
  return (
    cells.length > 0 &&
    cells.every((cell) => TABLE_SEPARATOR_CELL.test(cell.trim()))
  );
}

function isTableStart(lines: string[], start: number): boolean {
  return (
    start + 1 < lines.length &&
    isTableRow(lines[start]) &&
    isTableSeparator(lines[start + 1])
  );
}

function isHorizontalRule(
  line: string,
  lines: string[],
  index: number
): boolean {
  return HORIZONTAL_RULE.test(line.trim()) && !isTableStart(lines, index);
}

function isBlockStarter(line: string, lines: string[], index: number): boolean {
  return (
    FENCE_OPEN.test(line) ||
    HEADING.test(line) ||
    isHorizontalRule(line, lines, index) ||
    UNORDERED_LIST.test(line) ||
    ORDERED_LIST.test(line) ||
    isTableStart(lines, index)
  );
}

function parseCodeBlock(
  lines: string[],
  start: number
): { block?: MarkdownBlock; next: number } {
  const language = lines[start].match(FENCE_OPEN)?.[1] || undefined;
  let index = start + 1;
  const codeLines: string[] = [];
  while (index < lines.length && !FENCE_CLOSE.test(lines[index])) {
    codeLines.push(lines[index]);
    index += 1;
  }
  const closed = index < lines.length;
  if (closed) {
    index += 1;
  }
  const code = codeLines.join("\n");
  // Skip empty blocks and orphan opening fences (common in truncated model output).
  if (code.length === 0) {
    return { next: closed ? index : start + 1 };
  }
  return {
    block: { code, language, type: "code" },
    next: index,
  };
}

function parseListBlock(
  lines: string[],
  start: number,
  ordered: boolean
): { block: MarkdownBlock; next: number } {
  const items: MarkdownInline[][] = [];
  let index = start;
  const pattern = ordered ? ORDERED_LIST : UNORDERED_LIST;

  while (index < lines.length) {
    const item = lines[index].match(pattern);
    if (!item) {
      break;
    }
    items.push(parseInlines(item[1]));
    index += 1;
  }

  return {
    block: { items, ordered, type: "list" },
    next: index,
  };
}

function parseTableBlock(
  lines: string[],
  start: number
): { block: MarkdownBlock; next: number } {
  const headers = splitTableCells(lines[start]).map((cell) =>
    parseInlines(cell)
  );
  let index = start + 2;
  const rows: MarkdownInline[][][] = [];

  while (index < lines.length && isTableRow(lines[index])) {
    rows.push(splitTableCells(lines[index]).map((cell) => parseInlines(cell)));
    index += 1;
  }

  return {
    block: { headers, rows, type: "table" },
    next: index,
  };
}

function parseParagraphBlock(
  lines: string[],
  start: number
): { block: MarkdownBlock; next: number } {
  const paragraphLines: string[] = [];
  let index = start;
  while (index < lines.length) {
    const current = lines[index];
    if (current.trim() === "" || isBlockStarter(current, lines, index)) {
      break;
    }
    paragraphLines.push(current);
    index += 1;
  }
  return {
    block: {
      inlines: parseInlines(paragraphLines.join("\n")),
      type: "paragraph",
    },
    next: index,
  };
}

/** Parses a markdown string into blocks. Plain text becomes paragraph blocks. */
export function parseMarkdown(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (FENCE_OPEN.test(line)) {
      const parsed = parseCodeBlock(lines, index);
      if (parsed.block) {
        blocks.push(parsed.block);
      }
      index = parsed.next;
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({
        inlines: parseInlines(heading[2]),
        level: heading[1].length as HeadingLevel,
        type: "heading",
      });
      index += 1;
      continue;
    }

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    if (isHorizontalRule(line, lines, index)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }

    if (UNORDERED_LIST.test(line) || ORDERED_LIST.test(line)) {
      const parsed = parseListBlock(lines, index, ORDERED_LIST.test(line));
      blocks.push(parsed.block);
      index = parsed.next;
      continue;
    }

    if (isTableStart(lines, index)) {
      const parsed = parseTableBlock(lines, index);
      blocks.push(parsed.block);
      index = parsed.next;
      continue;
    }

    const parsed = parseParagraphBlock(lines, index);
    blocks.push(parsed.block);
    index = parsed.next;
  }

  return blocks;
}
