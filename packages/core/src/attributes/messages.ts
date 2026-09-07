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
