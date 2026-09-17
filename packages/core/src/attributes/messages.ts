import { TOOL_TYPE_FUNCTION } from "../semantic-conventions/attributes.js";
import { truncateAttribute } from "./helpers.js";
import {
  type AssistantTurn,
  readToolCall,
  readToolResponse,
  type ToolCallInfo,
  type ToolResponseInfo,
} from "./tools.js";

interface MessagePart {
  content?: string;
  type: string;
  value?: unknown;
}

interface PromptMessage {
  content: string | MessagePart[];
  role?: string;
}

interface TextPart {
  content: string;
  type: "text";
}

interface RedactedPart {
  /** The original part type, e.g. "image" or "audio". Never the value. */
  modality: string;
  type: "redacted";
}

/** A tool the model asked for, in GenAI message form. */
interface ToolCallPart {
  arguments?: unknown;
  id?: string;
  name: string;
  type: "tool_call";
}

/** The page's answer to a call, in GenAI message form. */
interface ToolCallResponsePart {
  error?: string;
  id?: string;
  name: string;
  response?: unknown;
  type: "tool_call_response";
}

type EncodedPart =
  | TextPart
  | RedactedPart
  | ToolCallPart
  | ToolCallResponsePart;

interface EncodedMessage {
  parts: EncodedPart[];
  role: string;
}

interface EncodedOutputMessage extends EncodedMessage {
  finish_reason: string;
}

function toolCallPart(call: ToolCallInfo): ToolCallPart {
  const part: ToolCallPart = { name: call.name, type: "tool_call" };
  // Chrome leaves the id empty, and an empty string reads as a real value.
  if (call.id) {
    part.id = call.id;
  }
  if (call.arguments !== undefined) {
    part.arguments = call.arguments;
  }
  return part;
}

function toolResponsePart(response: ToolResponseInfo): ToolCallResponsePart {
  const part: ToolCallResponsePart = {
    name: response.name,
    type: "tool_call_response",
  };
  if (response.id) {
    part.id = response.id;
  }
  if (response.errorMessage === undefined) {
    part.response = response.result;
  } else {
    part.error = response.errorMessage;
  }
  return part;
}

/** Returns a text part, or undefined for non-text (redactable) modalities. */
function textPartFrom(part: MessagePart): TextPart | undefined {
  if (part.type !== "text") {
    return;
  }
  return { content: String(part.value ?? part.content ?? ""), type: "text" };
}

function textPartsFrom(content: string | MessagePart[]): TextPart[] {
  if (typeof content === "string") {
    return [{ content, type: "text" }];
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
): EncodedMessage[] {
  if (typeof input === "string") {
    return [{ parts: [{ content: input, type: "text" }], role: "user" }];
  }
  const messages = Array.isArray(input) ? input : [input];
  return messages.map((message) => ({
    parts: encodeParts(message.content),
    role: message.role ?? "user",
  }));
}

function encodePart(part: MessagePart): EncodedPart {
  const text = textPartFrom(part);
  if (text) {
    return text;
  }
  if (part.type === "tool-call") {
    const call = readToolCall(part.value);
    if (call) {
      return toolCallPart(call);
    }
  }
  if (part.type === "tool-response") {
    const response = readToolResponse(part.value);
    if (response) {
      return toolResponsePart(response);
    }
  }
  // Other modalities are recorded by kind only, never by value.
  return { modality: part.type, type: "redacted" };
}

function encodeParts(content: string | MessagePart[]): EncodedPart[] {
  if (typeof content === "string") {
    return [{ content, type: "text" }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map(encodePart);
}

function outputParts(turn: AssistantTurn): EncodedPart[] {
  const parts: EncodedPart[] = [];
  // A turn that only asks for tools has no text, and gets no empty text part.
  if (turn.text) {
    parts.push({ content: turn.text, type: "text" });
  }
  for (const call of turn.toolCalls) {
    parts.push(toolCallPart(call));
  }
  return parts;
}

export function encodeOutputMessages(
  output: string | AssistantTurn,
  finishReason: string
): EncodedOutputMessage[] {
  const parts: EncodedPart[] =
    typeof output === "string"
      ? [{ content: output, type: "text" }]
      : outputParts(output);
  return [{ finish_reason: finishReason, parts, role: "assistant" }];
}

export function encodeSystemInstructions(
  initialPrompts: PromptMessage[]
): TextPart[] | undefined {
  const parts = initialPrompts
    .filter((message) => message.role === "system")
    .flatMap((message) => textPartsFrom(message.content));
  return parts.length > 0 ? parts : undefined;
}

interface OpenAiToolCall {
  /** OpenAI carries arguments as a JSON string, not as an object. */
  function: { name: string; arguments?: string };
  id?: string;
  type: string;
}

interface OpenAiMessage {
  content: string | null;
  role: string;
  tool_call_id?: string;
  tool_calls?: OpenAiToolCall[];
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    // Message parts are not always JSON-serializable.
  }
}

function openAiToolCall(part: ToolCallPart): OpenAiToolCall {
  const call: OpenAiToolCall = {
    function: { arguments: safeJson(part.arguments ?? {}), name: part.name },
    type: TOOL_TYPE_FUNCTION,
  };
  if (part.id) {
    call.id = part.id;
  }
  return call;
}

/** A result is its own message here, whatever role the Prompt API used. */
function openAiToolMessage(part: ToolCallResponsePart): OpenAiMessage {
  const message: OpenAiMessage = {
    content:
      safeJson(part.error === undefined ? part.response : part.error) ?? null,
    role: "tool",
  };
  if (part.id) {
    message.tool_call_id = part.id;
  }
  return message;
}

interface ShapedParts {
  text: string[];
  toolCalls: OpenAiToolCall[];
  /** Results, which stand on their own rather than joining the message. */
  toolMessages: OpenAiMessage[];
}

function shapeParts(parts: EncodedPart[]): ShapedParts {
  const shaped: ShapedParts = { text: [], toolCalls: [], toolMessages: [] };
  for (const part of parts) {
    if (part.type === "text") {
      shaped.text.push(part.content);
    } else if (part.type === "tool_call") {
      shaped.toolCalls.push(openAiToolCall(part));
    } else if (part.type === "tool_call_response") {
      shaped.toolMessages.push(openAiToolMessage(part));
    } else {
      // Enough to show the turn carried an image or audio, never the value.
      shaped.text.push(`[${part.modality}]`);
    }
  }
  return shaped;
}

function openAiMessages(message: {
  role: string;
  parts: EncodedPart[];
}): OpenAiMessage[] {
  const { text, toolCalls, toolMessages } = shapeParts(message.parts);
  if (text.length === 0 && toolCalls.length === 0) {
    return toolMessages;
  }
  const entry: OpenAiMessage = {
    content: text.join("\n") || null,
    role: message.role,
  };
  if (toolCalls.length > 0) {
    entry.tool_calls = toolCalls;
  }
  return [...toolMessages, entry];
}

/**
 * Re-shapes GenAI messages as OpenAI chat messages for MLflow.
 *
 * MLflow reads mlflow.spanInputs/Outputs both for the trace-table preview
 * columns and for a span's "Pretty" view. Left unset it derives them from the
 * GenAI attributes and then renders the derived copy alongside the original, so
 * every message appears twice; setting them here is what keeps a turn rendering
 * once. Tool calls and results have to come across too, or the turns that carry
 * nothing but tool traffic preview as blank.
 */
export function mlflowChatPreview(
  messages: Array<{ role: string; parts: EncodedPart[] }>,
  maxLength: number
): string | undefined {
  const chat = messages.flatMap(openAiMessages);
  if (chat.length === 0) {
    return;
  }
  return truncateAttribute(JSON.stringify({ messages: chat }), maxLength);
}
