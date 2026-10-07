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
  content: OpenAiContentPart[] | string;
  role: string;
}

function previewText(part: EncodedPart): string[] {
  if (part.type === "text") {
    return [part.content];
  }
  if (part.type === "redacted") {
    return [`[${part.modality}]`];
  }
  return [];
}

/**
 * A text-only chat preview of GenAI messages, for the spans that start a trace.
 *
 * MLflow renders `gen_ai.*` messages, tool traffic included, in a span's own
 * view. Its trace and session lists are the exception: they show the root
 * span's attribute as a raw string unless mlflow.spanInputs/Outputs is set.
 * Tool parts are left out, since a root carries the question and the answer.
 */
export function mlflowChatPreview(
  messages: Array<{ role: string; parts: EncodedPart[] }>,
  maxLength: number
): string | undefined {
  const chat = messages.flatMap(({ parts, role }) => {
    const content = parts.flatMap(previewText).join("\n");
    return content ? [{ content, role }] : [];
  });
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
): OpenAiContentPart {
  const text = textPartFrom(part);
  if (text) {
    return { text: text.content, type: "text" };
  }
  if (options?.captureMultimodalPreview) {
    const preview = extractMediaPreview(
      part.value ?? part.content,
      part.type,
      options
    );
    if (preview) {
      return (
        openAiContentPartFromPreview(part.type, preview) ?? placeholder(part)
      );
    }
  }
  return placeholder(part);
}

async function openAiContentPartFromRawAsync(
  part: MessagePart,
  options?: MultimodalPreviewOptions & { captureMultimodalPreview?: boolean }
): Promise<OpenAiContentPart> {
  const text = textPartFrom(part);
  if (text) {
    return { text: text.content, type: "text" };
  }
  if (options?.captureMultimodalPreview) {
    const preview = await extractMediaPreviewAsync(
      part.value ?? part.content,
      part.type,
      options
    );
    if (preview) {
      return (
        openAiContentPartFromPreview(part.type, preview) ?? placeholder(part)
      );
    }
  }
  return placeholder(part);
}

function placeholder(part: MessagePart): OpenAiTextPart {
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

function finalizeOpenAiContent(
  parts: OpenAiContentPart[]
): OpenAiContentPart[] | string | undefined {
  if (parts.length === 0) {
    return;
  }
  const hasMedia = parts.some((part) => part.type !== "text");
  if (hasMedia) {
    return parts;
  }
  return (parts as OpenAiTextPart[]).map((part) => part.text).join("\n");
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

function promptParts(
  input: string | PromptMessage | PromptMessage[]
): MessagePart[] {
  return promptMessages(input).flatMap(({ content }) =>
    Array.isArray(content) ? content : []
  );
}

const MEDIA_PART_TYPES = new Set(["audio", "image"]);
const TOOL_PART_TYPES = new Set(["tool-call", "tool-response"]);

/**
 * True when a prompt carries an image or audio part to preview inline. A
 * prompt that also carries tool traffic is left to the GenAI attributes, which
 * MLflow renders with the tool parts the preview would leave out.
 */
export function promptHasMediaPreview(
  input: string | PromptMessage | PromptMessage[]
): boolean {
  const parts = promptParts(input);
  return (
    parts.some((part) => MEDIA_PART_TYPES.has(part.type)) &&
    !parts.some((part) => TOOL_PART_TYPES.has(part.type))
  );
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
  return promptParts(input).some(partHasWebmAudio);
}

function previewMessage(
  message: PromptMessage,
  parts: OpenAiContentPart[]
): OpenAiMessage[] {
  const content = finalizeOpenAiContent(parts);
  return content === undefined
    ? []
    : [{ content, role: message.role ?? "user" }];
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
  const chat = promptMessages(input).flatMap((message) =>
    previewMessage(
      message,
      rawContentParts(message.content).map((part) =>
        openAiContentPartFromRaw(part, options)
      )
    )
  );
  return fitMlflowPreview(chat, maxLength);
}

export async function mlflowChatPreviewFromPromptAsync(
  input: string | PromptMessage | PromptMessage[],
  maxLength: number,
  options?: MultimodalPreviewOptions & { captureMultimodalPreview?: boolean }
): Promise<string | undefined> {
  const groups = await Promise.all(
    promptMessages(input).map(async (message) =>
      previewMessage(
        message,
        await Promise.all(
          rawContentParts(message.content).map((part) =>
            openAiContentPartFromRawAsync(part, options)
          )
        )
      )
    )
  );
  return fitMlflowPreview(groups.flat(), maxLength);
}
