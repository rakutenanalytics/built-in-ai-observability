import { GEN_AI } from "@web-ai-otel/core";

const MLFLOW_INPUTS = "mlflow.spanInputs";
const MLFLOW_OUTPUTS = "mlflow.spanOutputs";

export type IoView = "pretty" | "json";

export interface PrettyToolCall {
  id?: string;
  name: string;
  arguments?: unknown;
}

/** One card in the Pretty view — a user turn, a tool result, or tool calls. */
export interface PrettyMessage {
  role: string;
  title: string;
  text?: string;
  toolCalls?: PrettyToolCall[];
  /** Structured tool payload shown as key/value rows when there is no text. */
  fields?: Record<string, unknown>;
}

export interface IoPayload {
  /** Raw JSON for the JSON view. */
  json: string;
  /** Cards for the Pretty view; empty when only structured tool fields apply. */
  messages: PrettyMessage[];
  /** Tool-span arguments/results without a messages envelope. */
  fields?: Record<string, unknown>;
}

interface OpenAiToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
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
    return;
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
  return;
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
  return;
}

function mapOpenAiToolCalls(
  raw: OpenAiToolCall[] | undefined
): PrettyToolCall[] | undefined {
  return raw?.map((call) => ({
    id: call.id,
    name: call.function?.name ?? "tool",
    arguments: parseArguments(call.function?.arguments),
  }));
}

function openAiMessageCard(
  message: Record<string, unknown>
): PrettyMessage | undefined {
  const role = String(message.role ?? "unknown");
  const toolCalls = mapOpenAiToolCalls(
    message.tool_calls as OpenAiToolCall[] | undefined
  );
  const text = textFromContent(message.content);

  if (toolCalls?.length) {
    return { role, title: roleTitle(role), text, toolCalls };
  }

  if (role === "tool") {
    const parsedContent =
      typeof message.content === "string"
        ? parseJson(message.content)
        : message.content;
    const fields = objectFields(parsedContent);
    return {
      role,
      title: "Tool",
      text: fields ? undefined : text,
      fields,
    };
  }

  if (!text) {
    return;
  }
  return { role, title: roleTitle(role), text };
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
    role: "tool",
    title: "Tool",
    text: textFromContent(payload),
    fields: objectFields(payload),
  };
}

function genAiPartCards(part: GenAiPart): {
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
        id: typeof part.id === "string" ? part.id : undefined,
        name: String(part.name ?? "tool"),
        arguments: part.arguments,
      },
    };
  }
  if (part.type === "tool_call_response") {
    return { toolResponse: toolResponseCard(part) };
  }
  if (part.type === "redacted") {
    return { text: `[${String(part.modality ?? "redacted")}]` };
  }
  return {};
}

function genAiTurnCards(message: {
  role?: string;
  parts?: GenAiPart[];
}): PrettyMessage[] {
  const textParts: string[] = [];
  const toolCalls: PrettyToolCall[] = [];
  const cards: PrettyMessage[] = [];

  for (const part of message.parts ?? []) {
    const parsed = genAiPartCards(part);
    if (parsed.text) {
      textParts.push(parsed.text);
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
  if (toolCalls.length > 0) {
    cards.push({ role, title: roleTitle(role), text, toolCalls });
  } else if (text) {
    cards.push({ role, title: roleTitle(role), text });
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
    return { json, messages: [], fields };
  }
  // Not a plain object (an array, string, or number) — still worth showing.
  return {
    json,
    messages: [{ role: "tool", title, text: textFromContent(unwrapped) }],
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
