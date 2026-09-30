export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** Parsed markdown document — renderer-agnostic so the DOM layer can be swapped. */
export type MarkdownBlock =
  | { type: "code"; code: string; language?: string }
  | { type: "heading"; level: HeadingLevel; inlines: MarkdownInline[] }
  | { type: "hr" }
  | { type: "list"; ordered: boolean; items: MarkdownInline[][] }
  | { type: "paragraph"; inlines: MarkdownInline[] }
  | { type: "table"; headers: MarkdownInline[][]; rows: MarkdownInline[][][] };

export type MarkdownInline =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "strong"; children: MarkdownInline[] }
  | { type: "em"; children: MarkdownInline[] }
  | { type: "link"; href: string; children: MarkdownInline[] };
