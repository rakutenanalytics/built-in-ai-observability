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

/** A tool the model asked for, in GenAI message form. */
interface ToolCallPart {
  type: "tool_call";
  id?: string;
  name: string;
  arguments?: unknown;
}

/** The page's answer to a call, in GenAI message form. */
interface ToolCallResponsePart {
  type: "tool_call_response";
  id?: string;
  name: string;
  response?: unknown;
  error?: string;
}

type EncodedPart =
  | TextPart
  | RedactedPart
  | ToolCallPart
  | ToolCallResponsePart;

interface EncodedMessage {
  role: string;
  parts: EncodedPart[];
}

interface EncodedOutputMessage extends EncodedMessage {
  finish_reason: string;
}

function toolCallPart(call: ToolCallInfo): ToolCallPart {
  const part: ToolCallPart = { type: "tool_call", name: call.name };
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
    type: "tool_call_response",
    name: response.name,
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
): EncodedMessage[] {
  if (typeof input === "string") {
    return [{ role: "user", parts: [{ type: "text", content: input }] }];
  }
  const messages = Array.isArray(input) ? input : [input];
  return messages.map((message) => ({
    role: message.role ?? "user",
    parts: encodeParts(message.content),
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
  return { type: "redacted", modality: part.type };
}

function encodeParts(content: string | MessagePart[]): EncodedPart[] {
  if (typeof content === "string") {
    return [{ type: "text", content }];
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
    parts.push({ type: "text", content: turn.text });
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
      ? [{ type: "text", content: output }]
      : outputParts(output);
  return [{ role: "assistant", parts, finish_reason: finishReason }];
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
  id?: string;
  type: string;
  /** OpenAI carries arguments as a JSON string, not as an object. */
  function: { name: string; arguments?: string };
}

interface OpenAiMessage {
  role: string;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: OpenAiToolCall[];
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return;
  }
}

function openAiToolCall(part: ToolCallPart): OpenAiToolCall {
  const call: OpenAiToolCall = {
    type: TOOL_TYPE_FUNCTION,
    function: { name: part.name, arguments: safeJson(part.arguments ?? {}) },
  };
  if (part.id) {
    call.id = part.id;
  }
  return call;
}

/** A result is its own message here, whatever role the Prompt API used. */
function openAiToolMessage(part: ToolCallResponsePart): OpenAiMessage {
  const message: OpenAiMessage = {
    role: "tool",
    content:
      safeJson(part.error === undefined ? part.response : part.error) ?? null,
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
    role: message.role,
    content: text.join("\n") || null,
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
