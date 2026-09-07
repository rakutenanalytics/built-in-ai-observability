/**
 * Ambient declarations for the modern Prompt API (`LanguageModel` global).
 *
 * Hand-maintained rather than pulled from `@types/dom-chromium-ai`, which still
 * describes the older `ai.languageModel` shape. Shared across the workspace so
 * there is a single definition.
 */

type Availability =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

interface LanguageModelExpected {
  type: "text" | "image" | "audio";
  languages?: string[];
}

interface LanguageModelMessageContent {
  type: "text" | "image" | "audio";
  value: unknown;
}

interface LanguageModelMessage {
  role: "system" | "user" | "assistant";
  content: string | LanguageModelMessageContent[];
  prefix?: boolean;
}

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
  signal?: AbortSignal;
  monitor?: (m: EventTarget) => void;
}

interface LanguageModel extends EventTarget {
  prompt(
    input: LanguageModelPrompt,
    options?: LanguageModelPromptOptions
  ): Promise<string>;
  promptStreaming(
    input: LanguageModelPrompt,
    options?: LanguageModelPromptOptions
  ): ReadableStream<string>;
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

interface Window {
  LanguageModel?: LanguageModelConstructor;
}
