import { TOOL_TYPE_FUNCTION } from "../semantic-conventions/attributes.js";
import { truncateAttribute } from "./helpers.js";
import {
  audioFormatFromMime,
  extractMediaPreview,
  extractMediaPreviewAsync,
  isWebmAudio,
  type MediaPreview,
  type MultimodalPreviewOptions,
  mediaPreviewDataUri,
} from "./multimodal.js";
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

interface OpenAiTextPart {
  text: string;
  type: "text";
}

interface OpenAiImagePart {
  image_url: { url: string };
  type: "image_url";
}

interface OpenAiAudioPart {
  input_audio: { data: string; format: "mp3" | "wav" };
  type: "input_audio";
}

type OpenAiContentPart = OpenAiAudioPart | OpenAiImagePart | OpenAiTextPart;

interface OpenAiMessage {
  content: OpenAiContentPart[] | string | null;
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

/**
 * The Prompt API wraps a result as `[{ type, value }]`. A lone part is shown as
 * its payload, so MLflow renders the object the tool returned rather than the
 * envelope around it: as JSON it can pretty-print, or as the text itself.
 */
function toolResultContent(response: unknown): string | undefined {
  if (Array.isArray(response) && response.length === 1) {
    const [entry] = response;
    if (entry && typeof entry === "object" && "value" in entry) {
      const { type, value } = entry as { type?: unknown; value: unknown };
      return type === "text" && typeof value === "string"
        ? value
        : safeJson(value);
    }
  }
  return safeJson(response);
}

/** A result is its own message here, whatever role the Prompt API used. */
function openAiToolMessage(part: ToolCallResponsePart): OpenAiMessage {
  const message: OpenAiMessage = {
    content:
      part.error === undefined
        ? (toolResultContent(part.response) ?? null)
        : part.error,
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
  return fitMlflowPreview(chat, maxLength);
}

function openAiContentPartFromPreview(
  partType: string,
  preview: MediaPreview
): OpenAiContentPart | undefined {
  if (partType === "image") {
    return {
      image_url: { url: mediaPreviewDataUri(preview) },
      type: "image_url",
    };
  }
  if (partType === "audio") {
    return {
      input_audio: {
        data: preview.dataBase64,
        format: audioFormatFromMime(preview.mimeType),
      },
      type: "input_audio",
    };
  }
}

function openAiContentPartFromRaw(
  part: MessagePart,
  options?: MultimodalPreviewOptions & { captureMultimodalPreview?: boolean }
): OpenAiContentPart | undefined {
  const text = textPartFrom(part);
  if (text) {
    return { text: text.content, type: "text" };
  }
  if (part.type === "tool-call" || part.type === "tool-response") {
    return;
  }
  if (options?.captureMultimodalPreview) {
    const preview = extractMediaPreview(
      part.value ?? part.content,
      part.type,
      options
    );
    if (preview) {
      return openAiContentPartFromPreview(part.type, preview);
    }
  }
  return { text: `[${part.type}]`, type: "text" };
}

async function openAiContentPartFromRawAsync(
  part: MessagePart,
  options?: MultimodalPreviewOptions & { captureMultimodalPreview?: boolean }
): Promise<OpenAiContentPart | undefined> {
  const text = textPartFrom(part);
  if (text) {
    return { text: text.content, type: "text" };
  }
  if (part.type === "tool-call" || part.type === "tool-response") {
    return;
  }
  if (options?.captureMultimodalPreview) {
    const preview = await extractMediaPreviewAsync(
      part.value ?? part.content,
      part.type,
      options
    );
    if (preview) {
      return openAiContentPartFromPreview(part.type, preview);
    }
  }
  return { text: `[${part.type}]`, type: "text" };
}

function rawContentParts(
  content: string | MessagePart[] | undefined
): MessagePart[] {
  if (typeof content === "string") {
    return [{ content, type: "text" }];
  }
  if (Array.isArray(content)) {
    return content;
  }
  return [];
}

function contentFromRawParts(
  rawParts: MessagePart[],
  options?: MultimodalPreviewOptions & { captureMultimodalPreview?: boolean }
): OpenAiContentPart[] {
  return rawParts.flatMap((part) => {
    if (part.type === "tool-call" || part.type === "tool-response") {
      return [];
    }
    const content = openAiContentPartFromRaw(part, options);
    return content ? [content] : [];
  });
}

async function contentFromRawPartsAsync(
  rawParts: MessagePart[],
  options?: MultimodalPreviewOptions & { captureMultimodalPreview?: boolean }
): Promise<OpenAiContentPart[]> {
  const parts = await Promise.all(
    rawParts.map((part) => {
      if (part.type === "tool-call" || part.type === "tool-response") {
        return Promise.resolve(undefined);
      }
      return openAiContentPartFromRawAsync(part, options);
    })
  );
  return parts.filter((part): part is OpenAiContentPart => part !== undefined);
}

function finalizeOpenAiContent(
  parts: OpenAiContentPart[]
): OpenAiContentPart[] | string | null {
  if (parts.length === 0) {
    return null;
  }
  const hasMedia = parts.some((part) => part.type !== "text");
  if (hasMedia) {
    return parts;
  }
  const textParts = parts as OpenAiTextPart[];
  if (textParts.length === 1) {
    return textParts[0]?.text ?? null;
  }
  return textParts.map((part) => part.text).join("\n");
}

function assembleOpenAiMessages(
  encoded: EncodedMessage,
  contentParts: OpenAiContentPart[]
): OpenAiMessage[] {
  const { toolCalls, toolMessages } = shapeParts(encoded.parts);
  const content = finalizeOpenAiContent(contentParts);

  if (content === null && toolCalls.length === 0) {
    return toolMessages;
  }

  const entry: OpenAiMessage = { content, role: encoded.role };
  if (toolCalls.length > 0) {
    entry.tool_calls = toolCalls;
  }
  return [...toolMessages, entry];
}

function promptMessages(
  input: string | PromptMessage | PromptMessage[]
): PromptMessage[] {
  if (typeof input === "string") {
    return [{ content: input, role: "user" }];
  }
  if (Array.isArray(input)) {
    return input;
  }
  return [input];
}

function stripMediaBinary(messages: OpenAiMessage[]): OpenAiMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) {
      return message;
    }
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type === "image_url") {
          return {
            image_url: { url: "[image]" },
            type: "image_url" as const,
          };
        }
        if (part.type === "input_audio") {
          return {
            input_audio: {
              data: "",
              format: part.input_audio.format,
            },
            type: "input_audio" as const,
          };
        }
        return part;
      }),
    };
  });
}

/** Keeps MLflow preview JSON valid even when it exceeds the attribute cap. */
export function fitMlflowPreview(
  messages: OpenAiMessage[],
  maxLength: number
): string | undefined {
  if (messages.length === 0) {
    return;
  }
  let json = JSON.stringify({ messages });
  if (maxLength <= 0 || json.length <= maxLength) {
    return json;
  }
  json = JSON.stringify({ messages: stripMediaBinary(messages) });
  if (json.length <= maxLength) {
    return json;
  }
  return truncateAttribute(json, maxLength);
}

function partHasWebmAudio(part: MessagePart): boolean {
  if (part.type !== "audio") {
    return false;
  }
  const value = part.value ?? part.content;
  return value instanceof ArrayBuffer && isWebmAudio(new Uint8Array(value));
}

/** True when multimodal preview needs async audio transcoding before export. */
export function promptNeedsAsyncMlflowPreview(
  input: string | PromptMessage | PromptMessage[]
): boolean {
  for (const { content } of promptMessages(input)) {
    if (!Array.isArray(content)) {
      continue;
    }
    if (content.some(partHasWebmAudio)) {
      return true;
    }
  }
  return false;
}

/**
 * Builds MLflow OpenAI chat previews from raw Prompt API input so image and
 * audio parts can carry inline previews while GenAI attributes stay redacted.
 */
export function mlflowChatPreviewFromPrompt(
  input: string | PromptMessage | PromptMessage[],
  maxLength: number,
  options?: MultimodalPreviewOptions & { captureMultimodalPreview?: boolean }
): string | undefined {
  const encoded = encodeInputMessages(input);
  const rawMessages = promptMessages(input);

  const chat = encoded.flatMap((message, index) =>
    assembleOpenAiMessages(
      message,
      contentFromRawParts(rawContentParts(rawMessages[index]?.content), options)
    )
  );
  return fitMlflowPreview(chat, maxLength);
}

export async function mlflowChatPreviewFromPromptAsync(
  input: string | PromptMessage | PromptMessage[],
  maxLength: number,
  options?: MultimodalPreviewOptions & { captureMultimodalPreview?: boolean }
): Promise<string | undefined> {
  const encoded = encodeInputMessages(input);
  const rawMessages = promptMessages(input);
  const messageGroups = await Promise.all(
    encoded.map(async (message, index) =>
      assembleOpenAiMessages(
        message,
        await contentFromRawPartsAsync(
          rawContentParts(rawMessages[index]?.content),
          options
        )
      )
    )
  );

  return fitMlflowPreview(messageGroups.flat(), maxLength);
}
