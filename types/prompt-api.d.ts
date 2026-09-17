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

interface CreateMonitorEventMap {
  downloadprogress: ProgressEvent;
}

/**
 * Watches a model download. Only the members used here are declared, under the
 * names `@types/dom-chromium-ai` gives them, so adopting the package later is a
 * deletion rather than a rename.
 */
interface CreateMonitor extends EventTarget {
  addEventListener<K extends keyof CreateMonitorEventMap>(
    type: K,
    listener: (this: CreateMonitor, event: CreateMonitorEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): void;
}

type CreateMonitorCallback = (monitor: CreateMonitor) => void;

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
  languages?: string[];
  type: LanguageModelMessageType;
}

/**
 * All the model is told about a tool. The page keeps the implementation: the
 * browser never runs a tool, it only asks for one.
 */
interface LanguageModelToolDeclaration {
  description: string;
  inputSchema: object;
  name: string;
}

/**
 * A tool the model wants run. Chrome currently leaves `callID` an empty string,
 * including when several calls arrive in one turn, so it cannot be used to tell
 * calls apart.
 */
interface LanguageModelToolCall {
  readonly arguments: Record<string, unknown>;
  readonly callID: string;
  readonly name: string;
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
  readonly errorMessage: string;
  readonly name: string;
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
  content: string | LanguageModelMessageContent[];
  prefix?: boolean;
  /**
   * There is no `tool` role: tool responses travel as `user` content parts.
   */
  role: "system" | "user" | "assistant";
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
  omitResponseConstraintInput?: boolean;
  responseConstraint?: object;
  signal?: AbortSignal;
}

interface LanguageModelCloneOptions {
  signal?: AbortSignal;
}

interface LanguageModelCreateOptions {
  expectedInputs?: LanguageModelExpected[];
  expectedOutputs?: LanguageModelExpected[];
  initialPrompts?: LanguageModelMessage[];
  monitor?: CreateMonitorCallback;
  samplingMode?: string;
  signal?: AbortSignal;
  temperature?: number;
  tools?: LanguageModelToolDeclaration[];
  topK?: number;
}

interface LanguageModel extends EventTarget {
  clone: (options?: LanguageModelCloneOptions) => Promise<LanguageModel>;
  readonly contextUsage?: number;
  readonly contextWindow?: number;
  destroy: () => void;
  readonly inputQuota?: number;
  readonly inputUsage?: number;
  prompt: (
    input: LanguageModelPrompt,
    options?: LanguageModelPromptOptions
  ) => Promise<LanguageModelOutput>;
  promptStreaming: (
    input: LanguageModelPrompt,
    options?: LanguageModelPromptOptions
  ) => ReadableStream<LanguageModelStreamChunk>;
}

interface LanguageModelConstructor {
  availability: (options?: LanguageModelCreateOptions) => Promise<Availability>;
  create: (options?: LanguageModelCreateOptions) => Promise<LanguageModel>;
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
