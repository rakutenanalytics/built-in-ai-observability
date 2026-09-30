import { GEN_AI } from "@built-in-ai-obs/core";

const MLFLOW_INPUTS = "mlflow.spanInputs";
const MLFLOW_OUTPUTS = "mlflow.spanOutputs";

export type IoView = "pretty" | "json";

export interface PrettyToolCall {
  arguments?: unknown;
  id?: string;
  name: string;
}

export interface PrettyMedia {
  label?: string;
  placeholder?: boolean;
  src?: string;
  type: "audio" | "image";
}

/** One card in the Pretty view — a user turn, a tool result, or tool calls. */
export interface PrettyMessage {
  /** Structured tool payload shown as key/value rows when there is no text. */
  fields?: Record<string, unknown>;
  media?: PrettyMedia[];
  role: string;
  text?: string;
  title: string;
  toolCalls?: PrettyToolCall[];
}

export interface IoPayload {
  /** Tool-span arguments/results without a messages envelope. */
  fields?: Record<string, unknown>;
  /** Raw JSON for the JSON view. */
  json: string;
  /** Cards for the Pretty view; empty when only structured tool fields apply. */
  messages: PrettyMessage[];
}

interface OpenAiToolCall {
  function?: { name?: string; arguments?: string };
  id?: string;
}

type GenAiPart = Record<string, unknown>;

function roleTitle(role: string): string {
  switch (role) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    case "system":
      return "System";
    case "tool":
      return "Tool";
    default:
      return role;
  }
}

function parseJson(value: string | undefined): unknown {
  if (!value) {
    return;
  }
  try {
    return JSON.parse(value);
  } catch {
    // Preview payloads are not always JSON.
  }
}

function parseArguments(raw: string | undefined): unknown {
  if (!raw) {
    return;
  }
  const parsed = parseJson(raw);
  return parsed ?? raw;
}

function objectFields(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
}

function textFromContent(content: unknown): string | undefined {
  if (content === null || content === undefined) {
    return;
  }
  if (typeof content === "string") {
    return content;
  }
  return JSON.stringify(content, null, 2);
}

function messageArray(parsed: unknown): Record<string, unknown>[] | undefined {
  if (Array.isArray(parsed)) {
    return parsed as Record<string, unknown>[];
  }
  const envelope = parsed as { messages?: unknown };
  if (Array.isArray(envelope.messages)) {
    return envelope.messages as Record<string, unknown>[];
  }
}

function mapOpenAiToolCalls(
  raw: OpenAiToolCall[] | undefined
): PrettyToolCall[] | undefined {
  return raw?.map((call) => ({
    arguments: parseArguments(call.function?.arguments),
    id: call.id,
    name: call.function?.name ?? "tool",
  }));
}

function openAiImageMedia(entry: Record<string, unknown>): PrettyMedia {
  const url = (entry.image_url as { url?: string } | undefined)?.url;
  return url
    ? { src: url, type: "image" }
    : { placeholder: true, type: "image" };
}

function openAiAudioMedia(entry: Record<string, unknown>): PrettyMedia {
  const inputAudio = entry.input_audio as
    | { data?: string; format?: string }
    | undefined;
  if (!inputAudio?.data) {
    return { placeholder: true, type: "audio" };
  }
  const format = inputAudio.format === "wav" ? "wav" : "mp3";
  const mime = format === "wav" ? "audio/wav" : "audio/mpeg";
  return {
    src: `data:${mime};base64,${inputAudio.data}`,
    type: "audio",
  };
}

function openAiContentPart(
  part: unknown,
  textParts: string[],
  media: PrettyMedia[]
): void {
  if (!part || typeof part !== "object") {
    return;
  }
  const entry = part as Record<string, unknown>;
  const type = String(entry.type ?? "");

  if (type === "text") {
    const { text } = entry;
    if (typeof text === "string") {
      textParts.push(text);
    }
    return;
  }
  if (type === "image_url") {
    media.push(openAiImageMedia(entry));
    return;
  }
  if (type === "input_audio") {
    media.push(openAiAudioMedia(entry));
  }
}

function openAiContentParts(content: unknown): {
  media?: PrettyMedia[];
  text?: string;
} {
  if (typeof content === "string") {
    return { text: content };
  }
  if (!Array.isArray(content)) {
    return { text: textFromContent(content) };
  }

  const textParts: string[] = [];
  const media: PrettyMedia[] = [];
  for (const part of content) {
    openAiContentPart(part, textParts, media);
  }

  return {
    media: media.length > 0 ? media : undefined,
    text: textParts.length > 0 ? textParts.join("\n") : undefined,
  };
}

function openAiMessageCard(
  message: Record<string, unknown>
): PrettyMessage | undefined {
  const role = String(message.role ?? "unknown");
  const toolCalls = mapOpenAiToolCalls(
    message.tool_calls as OpenAiToolCall[] | undefined
  );
  const { media, text } = openAiContentParts(message.content);

  if (toolCalls?.length) {
    return { media, role, text, title: roleTitle(role), toolCalls };
  }

  if (role === "tool") {
    const parsedContent =
      typeof message.content === "string"
        ? parseJson(message.content)
        : message.content;
    const fields = objectFields(parsedContent);
    return {
      fields,
      role,
      text: fields ? undefined : text,
      title: "Tool",
    };
  }

  if (!(text || media?.length)) {
    return;
  }
  return { media, role, text, title: roleTitle(role) };
}

function openAiMessages(parsed: unknown): PrettyMessage[] | undefined {
  const messages = messageArray(parsed);
  if (!messages) {
    return;
  }

  const cards = messages
    .map(openAiMessageCard)
    .filter((card): card is PrettyMessage => card !== undefined);
  return cards.length > 0 ? cards : undefined;
}

function toolResponseCard(part: GenAiPart): PrettyMessage {
  const payload =
    part.error === undefined ? (part.response ?? part) : part.error;
  return {
    fields: objectFields(payload),
    role: "tool",
    text: textFromContent(payload),
    title: "Tool",
  };
}

function genAiPartCards(part: GenAiPart): {
  media?: PrettyMedia[];
  text?: string;
  toolCall?: PrettyToolCall;
  toolResponse?: PrettyMessage;
} {
  if (part.type === "text" && typeof part.content === "string") {
    return { text: part.content };
  }
  if (part.type === "tool_call") {
    return {
      toolCall: {
        arguments: part.arguments,
        id: typeof part.id === "string" ? part.id : undefined,
        name: String(part.name ?? "tool"),
      },
    };
  }
  if (part.type === "tool_call_response") {
    return { toolResponse: toolResponseCard(part) };
  }
  if (part.type === "redacted") {
    const modality = String(part.modality ?? "redacted");
    if (modality === "audio" || modality === "image") {
      return { media: [{ placeholder: true, type: modality }] };
    }
    return { text: `[${modality}]` };
  }
  return {};
}

function genAiTurnCards(message: {
  role?: string;
  parts?: GenAiPart[];
}): PrettyMessage[] {
  const textParts: string[] = [];
  const mediaParts: PrettyMedia[] = [];
  const toolCalls: PrettyToolCall[] = [];
  const cards: PrettyMessage[] = [];

  for (const part of message.parts ?? []) {
    const parsed = genAiPartCards(part);
    if (parsed.text) {
      textParts.push(parsed.text);
    }
    if (parsed.media) {
      mediaParts.push(...parsed.media);
    }
    if (parsed.toolCall) {
      toolCalls.push(parsed.toolCall);
    }
    if (parsed.toolResponse) {
      cards.push(parsed.toolResponse);
    }
  }

  const role = message.role ?? "user";
  const text = textParts.length > 0 ? textParts.join("\n") : undefined;
  const media = mediaParts.length > 0 ? mediaParts : undefined;
  if (toolCalls.length > 0) {
    cards.push({ media, role, text, title: roleTitle(role), toolCalls });
  } else if (text || media) {
    cards.push({ media, role, text, title: roleTitle(role) });
  }
  return cards;
}

function genAiMessages(parsed: unknown): PrettyMessage[] | undefined {
  if (!Array.isArray(parsed)) {
    return;
  }

  const cards = (
    parsed as Array<{ role?: string; parts?: GenAiPart[] }>
  ).flatMap(genAiTurnCards);
  return cards.length > 0 ? cards : undefined;
}

/**
 * Tool results come from the page as a content part, e.g.
 * `[{ type: "object", value: {...} }]`, per the Prompt API's
 * `LanguageModelToolSuccess` shape — the same envelope arguments never carry.
 * Unwrapped, so the actual payload renders instead of vanishing because an
 * array isn't a plain object.
 */
function unwrapToolValue(value: unknown): unknown {
  if (Array.isArray(value) && value.length === 1) {
    const [entry] = value;
    if (
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      "value" in entry
    ) {
      return (entry as { value: unknown }).value;
    }
  }
  return value;
}

function toolFields(json: string, title: string): IoPayload | undefined {
  const parsed = parseJson(json);
  if (parsed === undefined) {
    return;
  }
  const unwrapped = unwrapToolValue(parsed);
  const fields = objectFields(unwrapped);
  if (fields) {
    return { fields, json, messages: [] };
  }
  // Not a plain object (an array, string, or number) — still worth showing.
  return {
    json,
    messages: [{ role: "tool", text: textFromContent(unwrapped), title }],
  };
}

function resolveMessages(
  mlflow: string | undefined,
  genAi: string | undefined
): IoPayload | undefined {
  const mlflowJson = mlflow ?? genAi;
  if (!mlflowJson) {
    return;
  }

  const parsed = parseJson(mlflowJson);
  const messages =
    openAiMessages(parsed) ?? genAiMessages(parsed) ?? ([] as PrettyMessage[]);
  return { json: mlflowJson, messages };
}

function stringAttr(
  attributes: Record<string, unknown>,
  key: string
): string | undefined {
  const value = attributes[key];
  return typeof value === "string" ? value : undefined;
}

/** Inputs for a span: chat messages first, then execute_tool arguments. */
export function spanInputs(
  attributes: Record<string, unknown>
): IoPayload | undefined {
  const mlflow = stringAttr(attributes, MLFLOW_INPUTS);
  const genAi = stringAttr(attributes, GEN_AI.INPUT_MESSAGES);
  const fromMessages = resolveMessages(mlflow, genAi);
  if (fromMessages) {
    return fromMessages;
  }

  const toolArgs = stringAttr(attributes, GEN_AI.TOOL_CALL_ARGUMENTS);
  return toolArgs ? toolFields(toolArgs, "Arguments") : undefined;
}

/** Outputs for a span: chat messages first, then execute_tool results. */
export function spanOutputs(
  attributes: Record<string, unknown>
): IoPayload | undefined {
  const mlflow = stringAttr(attributes, MLFLOW_OUTPUTS);
  const genAi = stringAttr(attributes, GEN_AI.OUTPUT_MESSAGES);
  const fromMessages = resolveMessages(mlflow, genAi);
  if (fromMessages) {
    return fromMessages;
  }

  const toolResult = stringAttr(attributes, GEN_AI.TOOL_CALL_RESULT);
  return toolResult ? toolFields(toolResult, "Result") : undefined;
}
