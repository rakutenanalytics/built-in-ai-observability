interface MessagePart {
  type: string;
  value?: unknown;
  content?: string;
}

interface PromptMessage {
  role?: string;
  content: string | MessagePart[];
}

interface TextPart {
  type: "text";
  content: string;
}

interface RedactedPart {
  type: "redacted";
  /** The original part type, e.g. "image" or "audio". Never the value. */
  modality: string;
}

type EncodedPart = TextPart | RedactedPart;

/** Returns a text part, or undefined for non-text (redactable) modalities. */
function textPartFrom(part: MessagePart): TextPart | undefined {
  if (part.type !== "text") {
    return;
  }
  return { type: "text", content: String(part.value ?? part.content ?? "") };
}

function textPartsFrom(content: string | MessagePart[]): TextPart[] {
  if (typeof content === "string") {
    return [{ type: "text", content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .map(textPartFrom)
    .filter((part): part is TextPart => part !== undefined);
}

export function encodeInputMessages(
  input: string | PromptMessage | PromptMessage[]
): Array<{ role: string; parts: EncodedPart[] }> {
  if (typeof input === "string") {
    return [{ role: "user", parts: [{ type: "text", content: input }] }];
  }
  const messages = Array.isArray(input) ? input : [input];
  return messages.map((message) => ({
    role: message.role ?? "user",
    parts: encodeParts(message.content),
  }));
}

function encodeParts(content: string | MessagePart[]): EncodedPart[] {
  if (typeof content === "string") {
    return [{ type: "text", content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  // Non-text modalities are recorded by kind only, never by value.
  return content.map(
    (part) => textPartFrom(part) ?? { type: "redacted", modality: part.type }
  );
}

export function encodeOutputMessages(
  text: string,
  finishReason: string
): Array<{
  role: string;
  parts: Array<{ type: string; content: string }>;
  finish_reason: string;
}> {
  return [
    {
      role: "assistant",
      parts: [{ type: "text", content: text }],
      finish_reason: finishReason,
    },
  ];
}

export function textFromGenAiMessages(
  messages: Array<{ parts?: Array<{ type: string; content?: string }> }>
): string {
  const lines: string[] = [];
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part.type === "text" && part.content) {
        lines.push(part.content);
      }
    }
  }
  return lines.join("\n");
}

export function encodeSystemInstructions(
  initialPrompts: PromptMessage[]
): TextPart[] | undefined {
  const parts = initialPrompts
    .filter((message) => message.role === "system")
    .flatMap((message) => textPartsFrom(message.content));
  return parts.length > 0 ? parts : undefined;
}

export function textFromSystemInstructions(
  parts: Array<{ type: string; content: string }>
): string {
  return parts
    .map((part) => (part.type === "text" ? part.content : ""))
    .filter(Boolean)
    .join("\n");
}

export function mlflowChatPreview(role: string, text: string): string {
  return JSON.stringify({ messages: [{ role, content: text }] });
}
