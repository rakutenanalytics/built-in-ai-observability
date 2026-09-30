import { describe, expect, it } from "vitest";
import { parseInlines, parseMarkdown } from "../src/panel/markdown/parse.js";

describe("parseMarkdown", () => {
  it("parses fenced code blocks", () => {
    const blocks = parseMarkdown("```ts\nconst x = 1;\n```");
    expect(blocks).toEqual([
      { code: "const x = 1;", language: "ts", type: "code" },
    ]);
  });

  it("parses headings, lists, and paragraphs", () => {
    const blocks = parseMarkdown(
      "# Title\n\nHello **world**.\n\n- one\n- two\n\n1. first\n2. second"
    );
    expect(blocks).toEqual([
      {
        inlines: [{ type: "text", value: "Title" }],
        level: 1,
        type: "heading",
      },
      {
        inlines: [
          { type: "text", value: "Hello " },
          { children: [{ type: "text", value: "world" }], type: "strong" },
          { type: "text", value: "." },
        ],
        type: "paragraph",
      },
      {
        items: [
          [{ type: "text", value: "one" }],
          [{ type: "text", value: "two" }],
        ],
        ordered: false,
        type: "list",
      },
      {
        items: [
          [{ type: "text", value: "first" }],
          [{ type: "text", value: "second" }],
        ],
        ordered: true,
        type: "list",
      },
    ]);
  });

  it("parses h4 through h6 headings", () => {
    const blocks = parseMarkdown("#### H4\n##### H5\n###### H6");
    expect(blocks).toEqual([
      {
        inlines: [{ type: "text", value: "H4" }],
        level: 4,
        type: "heading",
      },
      {
        inlines: [{ type: "text", value: "H5" }],
        level: 5,
        type: "heading",
      },
      {
        inlines: [{ type: "text", value: "H6" }],
        level: 6,
        type: "heading",
      },
    ]);
  });

  it("parses horizontal rules", () => {
    const blocks = parseMarkdown("Above\n\n---\n\nBelow");
    expect(blocks).toEqual([
      {
        inlines: [{ type: "text", value: "Above" }],
        type: "paragraph",
      },
      { type: "hr" },
      {
        inlines: [{ type: "text", value: "Below" }],
        type: "paragraph",
      },
    ]);
  });

  it("does not treat table separator rows as horizontal rules", () => {
    const blocks = parseMarkdown("| A | B |\n|---|---|\n| 1 | 2 |");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("table");
  });

  it("skips orphan and empty fenced code blocks", () => {
    expect(parseMarkdown("This is a code block.\n```")).toEqual([
      {
        inlines: [{ type: "text", value: "This is a code block." }],
        type: "paragraph",
      },
    ]);
    expect(parseMarkdown("```\n```")).toEqual([]);
  });

  it("parses gfm pipe tables", () => {
    const blocks = parseMarkdown(
      "| Model | Tokens |\n| ----- | ------ |\n| Gemma | 8192 |\n| Nano | 4096 |"
    );
    expect(blocks).toEqual([
      {
        headers: [
          [{ type: "text", value: "Model" }],
          [{ type: "text", value: "Tokens" }],
        ],
        rows: [
          [
            [{ type: "text", value: "Gemma" }],
            [{ type: "text", value: "8192" }],
          ],
          [
            [{ type: "text", value: "Nano" }],
            [{ type: "text", value: "4096" }],
          ],
        ],
        type: "table",
      },
    ]);
  });

  it("treats pipe lines without a separator row as paragraphs", () => {
    const blocks = parseMarkdown("| not | a | table |");
    expect(blocks).toEqual([
      {
        inlines: [{ type: "text", value: "| not | a | table |" }],
        type: "paragraph",
      },
    ]);
  });

  it("keeps raw html as plain text", () => {
    const blocks = parseMarkdown('<script>alert("xss")</script>');
    expect(blocks).toEqual([
      {
        inlines: [{ type: "text", value: '<script>alert("xss")</script>' }],
        type: "paragraph",
      },
    ]);
  });
});

describe("parseInlines", () => {
  it("parses inline code, emphasis, and links", () => {
    expect(
      parseInlines("Use `foo` and *bar* with [docs](https://example.com).")
    ).toEqual([
      { type: "text", value: "Use " },
      { type: "code", value: "foo" },
      { type: "text", value: " and " },
      { children: [{ type: "text", value: "bar" }], type: "em" },
      { type: "text", value: " with " },
      {
        children: [{ type: "text", value: "docs" }],
        href: "https://example.com",
        type: "link",
      },
      { type: "text", value: "." },
    ]);
  });

  it("parses javascript links without treating them as special syntax", () => {
    expect(parseInlines("[click](javascript:alert(1))")).toEqual([
      {
        children: [{ type: "text", value: "click" }],
        href: "javascript:alert(1)",
        type: "link",
      },
    ]);
  });
});
