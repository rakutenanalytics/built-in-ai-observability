/**
 * Ambient declarations for the modern Prompt API (`LanguageModel` global),
 * shared across the workspace so there is a single definition.
 *
 * `@types/dom-chromium-ai` is the better long-term home and already covers this
 * API in more depth, but as of 0.0.17 it still describes the previous tool
 * design, where a declared tool carries an `execute` callback the browser
 * invokes. Chrome has since inverted that: the model emits a `tool-call`, the
 * page runs the tool itself and answers with a `LanguageModelToolSuccess` or
 * `LanguageModelToolError`. So the package types a tool as something we cannot
 * pass, and types `prompt()` as `Promise<string>` when a tool turn resolves to
 * content parts. Declaration merging cannot narrow a member of the class it
 * declares, so the two cannot be reconciled locally. Drop this file for the
 * package once it ships the tool-call shape.
 */

type Availability =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

/**
 * Tool traffic is declared like any other modality. `tool-call` and
 * `tool-response` require chrome://flags/#prompt-api-tool-use.
 */
type LanguageModelMessageType =
  | "text"
  | "image"
  | "audio"
  | "tool-call"
  | "tool-response";

interface LanguageModelExpected {
  type: LanguageModelMessageType;
  languages?: string[];
}

/**
 * All the model is told about a tool. The page keeps the implementation: the
 * browser never runs a tool, it only asks for one.
 */
interface LanguageModelToolDeclaration {
  name: string;
  description: string;
  inputSchema: object;
}

/**
 * A tool the model wants run. Chrome currently leaves `callID` an empty string,
 * including when several calls arrive in one turn, so it cannot be used to tell
 * calls apart.
 */
interface LanguageModelToolCall {
  readonly callID: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** Chrome supports only `text` and `object` results, not `image` or `audio`. */
interface LanguageModelToolResultContent {
  type: "text" | "object";
  value: unknown;
}

interface LanguageModelToolSuccess {
  readonly callID: string;
  readonly name: string;
  readonly result: LanguageModelToolResultContent[];
}

interface LanguageModelToolError {
  readonly callID: string;
  readonly name: string;
  readonly errorMessage: string;
}

type LanguageModelToolResponse =
  | LanguageModelToolSuccess
  | LanguageModelToolError;

interface LanguageModelDataContent {
  type: "text" | "image" | "audio";
  value: unknown;
}

interface LanguageModelToolCallContent {
  type: "tool-call";
  value: LanguageModelToolCall;
}

interface LanguageModelToolResponseContent {
  type: "tool-response";
  value: LanguageModelToolResponse;
}

type LanguageModelMessageContent =
  | LanguageModelDataContent
  | LanguageModelToolCallContent
  | LanguageModelToolResponseContent;

interface LanguageModelMessage {
  /**
   * There is no `tool` role: tool responses travel as `user` content parts.
   */
  role: "system" | "user" | "assistant";
  content: string | LanguageModelMessageContent[];
  prefix?: boolean;
}

/**
 * A completed turn. Plain text collapses to a string, but a turn that asks for
 * a tool resolves to a content sequence instead.
 */
type LanguageModelOutput = string | LanguageModelMessageContent[];

/**
 * Stream chunks are heterogeneous: text arrives as bare strings, while each
 * tool call arrives as its own structured chunk.
 */
type LanguageModelStreamChunk = string | LanguageModelMessageContent;

type LanguageModelPrompt =
  | string
  | LanguageModelMessage[]
  | LanguageModelMessage;

interface LanguageModelPromptOptions {
  responseConstraint?: object;
  omitResponseConstraintInput?: boolean;
  signal?: AbortSignal;
}

interface LanguageModelCloneOptions {
  signal?: AbortSignal;
}

interface LanguageModelCreateOptions {
  topK?: number;
  temperature?: number;
  samplingMode?: string;
  expectedInputs?: LanguageModelExpected[];
  expectedOutputs?: LanguageModelExpected[];
  initialPrompts?: LanguageModelMessage[];
  tools?: LanguageModelToolDeclaration[];
  signal?: AbortSignal;
  monitor?: (m: EventTarget) => void;
}

interface LanguageModel extends EventTarget {
  prompt(
    input: LanguageModelPrompt,
    options?: LanguageModelPromptOptions
  ): Promise<LanguageModelOutput>;
  promptStreaming(
    input: LanguageModelPrompt,
    options?: LanguageModelPromptOptions
  ): ReadableStream<LanguageModelStreamChunk>;
  clone(options?: LanguageModelCloneOptions): Promise<LanguageModel>;
  destroy(): void;
  readonly contextWindow?: number;
  readonly contextUsage?: number;
  readonly inputQuota?: number;
  readonly inputUsage?: number;
}

interface LanguageModelConstructor {
  create(options?: LanguageModelCreateOptions): Promise<LanguageModel>;
  availability(options?: LanguageModelCreateOptions): Promise<Availability>;
}

declare const LanguageModel: LanguageModelConstructor;

/**
 * A tool response has to be one of these instances: a plain object of the same
 * shape is rejected. Both are flag-gated, so their absence identifies a missing
 * chrome://flags/#prompt-api-tool-use rather than a missing Prompt API.
 */
declare const LanguageModelToolSuccess: {
  prototype: LanguageModelToolSuccess;
  new (init: {
    callID: string;
    name: string;
    result: LanguageModelToolResultContent[];
  }): LanguageModelToolSuccess;
};

declare const LanguageModelToolError: {
  prototype: LanguageModelToolError;
  new (init: {
    callID: string;
    name: string;
    errorMessage: string;
  }): LanguageModelToolError;
};

interface Window {
  LanguageModel?: LanguageModelConstructor;
}
