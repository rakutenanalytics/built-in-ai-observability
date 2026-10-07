import {
  type AssistantTurn,
  contextAttributes,
  encodeInputMessages,
  encodeOutputMessages,
  encodeSystemInstructions,
  FINISH_STOP,
  GEN_AI,
  type InstrumentationConfig,
  mlflowChatPreview,
  mlflowChatPreviewFromPrompt,
  mlflowChatPreviewFromPromptAsync,
  OPERATION_GENERATE_CONTENT,
  OPERATION_INVOKE_AGENT,
  PROMPT_API_NAME,
  promptHasMediaPreview,
  promptNeedsAsyncMlflowPreview,
  readContextUsage,
  type SessionTelemetryMeta,
  sessionAttributes,
  TOOL_TYPE_FUNCTION,
  type ToolCallInfo,
  type ToolTraffic,
  truncateAttribute,
  WEB_AI,
} from "@built-in-ai-obs/core";
import type { Attributes, Context, Span } from "@opentelemetry/api";

const MLFLOW_INPUTS = "mlflow.spanInputs";
const MLFLOW_OUTPUTS = "mlflow.spanOutputs";
const DEFAULT_MLFLOW_MEDIA_PREVIEW_LENGTH = 1_048_576;

/**
 * A call the model asked for and the page has not answered yet. The tool runs
 * in page code, out of reach of this instrumentation, so the only way to time
 * it is to remember when the page could first run it and wait for its response.
 */
export interface PendingToolCall extends ToolCallInfo {
  /** Set when the browser sent no `callId` and the id was made up here. */
  generatedId: boolean;
  /** Context of the turn that asked for the call. */
  parent: Context;
  /**
   * When the turn that asked for it ended, so the tool span can be backdated.
   * Epoch ms off the monotonic clock — see `spanTimestamp`.
   */
  runnableAt: number;
  turnIndex: number;
}

export interface SessionState extends SessionTelemetryMeta {
  activeSpans: Set<Span>;
  compacted: boolean;
  /** The exchange in flight, if the current question needed tools. */
  exchange?: Exchange;
  /** Numbers the ids made up for calls that arrive without a `callId`. */
  generatedCallSeq: number;
  pendingCalls: PendingToolCall[];
  /**
   * Set when the session reports an overflow while no span is in flight, so the
   * next turn can carry it. Cleared once attributed.
   */
  pendingOverflow: boolean;
  /** Declared tools by name, so a tool span can carry its description. */
  tools: Map<string, LanguageModelToolDeclaration>;
  turnIndex: number;
}

/**
 * A question being answered with tools, spanning several model turns.
 *
 * The turns and tool runs of an exchange are siblings under one `invoke_agent`
 * span rather than nested inside the first turn: they happen one after another,
 * and a turn does not run inside the turn before it. That span is also what
 * carries the exchange's answer, since the final text arrives on the last turn
 * while a trace is read from its root.
 */
export interface Exchange {
  context: Context;
  span: Span;
  toolCalls: number;
  turns: number;
  usageBefore?: number;
  windowTokens?: number;
}

const overflowRecordedSpans = new WeakSet<Span>();

/** Identity attributes shared by every span this instrumentation emits. */
export function promptApiAttributes(state: SessionTelemetryMeta): Attributes {
  return {
    [WEB_AI.API_NAME]: PROMPT_API_NAME,
    ...sessionAttributes(state),
  };
}

export function createSessionState(
  meta: SessionTelemetryMeta,
  tools: LanguageModelToolDeclaration[] = []
): SessionState {
  return {
    ...meta,
    activeSpans: new Set(),
    compacted: false,
    generatedCallSeq: 0,
    pendingCalls: [],
    pendingOverflow: false,
    tools: new Map(tools.map((tool) => [tool.name, tool])),
    turnIndex: 0,
  };
}

function toolDeclarationAttributes(
  tools: LanguageModelToolDeclaration[],
  config: InstrumentationConfig
): Attributes {
  const attributes: Attributes = {
    [WEB_AI.TOOL_COUNT]: tools.length,
    [WEB_AI.TOOL_NAMES]: tools.map((tool) => tool.name),
  };

  // Declarations are app-authored rather than user content, but they are part
  // of what the model is prompted with, so they follow the input setting.
  if (config.captureInput) {
    attributes[GEN_AI.TOOL_DEFINITIONS] = truncateAttribute(
      JSON.stringify(
        tools.map(({ name, description, inputSchema }) => ({
          description,
          name,
          parameters: inputSchema,
          type: TOOL_TYPE_FUNCTION,
        }))
      ),
      config.maxAttributeLength
    );
  }

  return attributes;
}

function systemInstructionAttributes(
  initialPrompts: LanguageModelMessage[],
  config: InstrumentationConfig
): Attributes {
  const instructions = encodeSystemInstructions(
    initialPrompts as Array<{
      role?: string;
      content:
        | string
        | Array<{ type: string; value?: unknown; content?: string }>;
    }>
  );
  if (!instructions) {
    return {};
  }

  const attributes: Attributes = {
    [GEN_AI.SYSTEM_INSTRUCTIONS]: truncateAttribute(
      JSON.stringify(instructions),
      config.maxAttributeLength
    ),
  };
  if (config.includeMlflowPreview) {
    const preview = mlflowChatPreview(
      [{ parts: instructions, role: "system" }],
      config.maxAttributeLength
    );
    if (preview) {
      attributes[MLFLOW_INPUTS] = preview;
    }
  }
  return attributes;
}

export function createSessionAttributes(
  options: LanguageModelCreateOptions,
  config: InstrumentationConfig
): Attributes {
  const attributes: Attributes = {};

  if (options.tools?.length) {
    Object.assign(attributes, toolDeclarationAttributes(options.tools, config));
  }

  if (options.expectedInputs?.length) {
    attributes[WEB_AI.SESSION_EXPECTED_INPUTS] = JSON.stringify(
      options.expectedInputs
    );
  }
  if (options.expectedOutputs?.length) {
    attributes[WEB_AI.SESSION_EXPECTED_OUTPUTS] = JSON.stringify(
      options.expectedOutputs
    );
  }
  if (options.samplingMode) {
    attributes[WEB_AI.SAMPLING_MODE] = options.samplingMode;
  }

  if (config.captureInput && options.initialPrompts?.length) {
    Object.assign(
      attributes,
      systemInstructionAttributes(options.initialPrompts, config)
    );
  }

  return attributes;
}

export function recordContextOverflow(
  span: Span,
  before: number | undefined,
  after: number | undefined
): void {
  if (overflowRecordedSpans.has(span)) {
    return;
  }
  overflowRecordedSpans.add(span);

  const eventAttrs: Record<string, number | boolean> = {
    [WEB_AI.CONTEXT_OVERFLOWED]: true,
    [GEN_AI.CONVERSATION_COMPACTED]: true,
  };
  if (before !== undefined) {
    eventAttrs[WEB_AI.CONTEXT_USAGE_BEFORE] = before;
  }
  if (after !== undefined) {
    eventAttrs[WEB_AI.CONTEXT_USAGE_AFTER] = after;
  }
  if (before !== undefined && after !== undefined) {
    eventAttrs[WEB_AI.CONTEXT_USAGE_DELTA] = after - before;
  }

  span.addEvent("web_ai.context_overflow", eventAttrs);
  span.setAttribute(WEB_AI.CONTEXT_OVERFLOWED, true);
  span.setAttribute(GEN_AI.CONVERSATION_COMPACTED, true);
}

export function reconcileContextOverflow(
  span: Span,
  state: SessionState,
  before: number | undefined,
  after: number | undefined
): void {
  // A usage drop across the turn means the model compacted the context itself,
  // even if no overflow event fired.
  const usageDropped =
    before !== undefined && after !== undefined && after < before;

  if (!(state.pendingOverflow || usageDropped)) {
    return;
  }

  state.pendingOverflow = false;
  state.compacted = true;
  recordContextOverflow(span, before, after);
}

export interface TurnRequest {
  config: InstrumentationConfig;
  input: unknown;
  options?: LanguageModelPromptOptions;
  providerName: string;
  state: SessionState;
  streaming: boolean;
  traffic: ToolTraffic;
}

function mlflowPreviewOptions(config: InstrumentationConfig): {
  captureMultimodalPreview: true;
  maxPreviewBytes?: number;
} {
  return {
    captureMultimodalPreview: true,
    maxPreviewBytes: config.multimodalPreviewMaxBytes,
  };
}

/**
 * Media previews are bounded by multimodalPreviewMaxBytes, not by the text
 * attribute cap — applying the latter would strip the base64 back out.
 */
function mlflowMediaPreviewMaxLength(config: InstrumentationConfig): number {
  return (
    config.maxMlflowMediaPreviewLength ?? DEFAULT_MLFLOW_MEDIA_PREVIEW_LENGTH
  );
}

/** Media the GenAI attributes redact, which only an MLflow preview can show. */
function wantsMediaPreview(
  prompt: LanguageModelPrompt,
  config: InstrumentationConfig
): boolean {
  return Boolean(
    config.includeMlflowPreview &&
      config.captureMultimodalPreview &&
      promptHasMediaPreview(prompt)
  );
}

/**
 * `root` marks a span that starts a trace, the only place a text preview is
 * written: MLflow fills its trace and session lists from it.
 */
function captureInputAttributes(
  attributes: Attributes,
  { input, config }: TurnRequest,
  root: boolean
): void {
  const prompt = input as LanguageModelPrompt;
  const inputMessages = encodeInputMessages(prompt);
  attributes[GEN_AI.INPUT_MESSAGES] = truncateAttribute(
    JSON.stringify(inputMessages),
    config.maxAttributeLength
  );
  if (!config.includeMlflowPreview) {
    return;
  }
  if (wantsMediaPreview(prompt, config)) {
    // WebM audio is set later, by enrichMlflowInputPreview.
    if (!promptNeedsAsyncMlflowPreview(prompt)) {
      setPreview(
        attributes,
        MLFLOW_INPUTS,
        mlflowChatPreviewFromPrompt(
          prompt,
          mlflowMediaPreviewMaxLength(config),
          mlflowPreviewOptions(config)
        )
      );
    }
    return;
  }
  if (root) {
    setPreview(
      attributes,
      MLFLOW_INPUTS,
      mlflowChatPreview(inputMessages, config.maxAttributeLength)
    );
  }
}

function setPreview(
  attributes: Attributes,
  key: string,
  preview: string | undefined
): void {
  if (preview) {
    attributes[key] = preview;
  }
}

/** WebM audio is transcoded to WAV asynchronously after the span opens. */
export async function enrichMlflowInputPreview(
  span: Span,
  input: unknown,
  config: InstrumentationConfig
): Promise<void> {
  const prompt = input as LanguageModelPrompt;
  if (
    !(
      wantsMediaPreview(prompt, config) && promptNeedsAsyncMlflowPreview(prompt)
    )
  ) {
    return;
  }
  const preview = await mlflowChatPreviewFromPromptAsync(
    prompt,
    mlflowMediaPreviewMaxLength(config),
    mlflowPreviewOptions(config)
  );
  if (preview) {
    span.setAttributes({ [MLFLOW_INPUTS]: preview });
  }
}

export function requestAttributes(request: TurnRequest): Attributes {
  const { state, options, streaming, config, providerName, traffic } = request;
  state.turnIndex += 1;

  const attributes: Attributes = {
    [GEN_AI.OPERATION_NAME]: OPERATION_GENERATE_CONTENT,
    [GEN_AI.PROVIDER_NAME]: providerName,
    ...promptApiAttributes(state),
    [WEB_AI.TURN_INDEX]: state.turnIndex,
  };

  if (streaming) {
    attributes[GEN_AI.REQUEST_STREAM] = true;
  }
  if (options?.responseConstraint) {
    attributes[GEN_AI.OUTPUT_TYPE] = "json";
  }
  if (state.compacted) {
    attributes[GEN_AI.CONVERSATION_COMPACTED] = true;
  }
  // Tool responses in the input mean the page is answering the previous turn.
  if (traffic.responses.length > 0) {
    attributes[WEB_AI.TURN_CONTINUATION] = true;
    attributes[WEB_AI.TOOL_RESPONSE_COUNT] = traffic.responses.length;
  }

  if (config.captureInput) {
    // A turn inside an exchange is not where a trace starts.
    captureInputAttributes(attributes, request, !state.exchange);
  }

  return attributes;
}

export interface TurnResult {
  after?: number;
  before?: number;
  config: InstrumentationConfig;
  finishReason: string;
  output?: string | AssistantTurn;
  session: LanguageModel;
  state: SessionState;
  windowTokens?: number;
}

/** Names of the tools a turn asked for, recorded whatever the capture config. */
function toolCallAttributes(output: string | AssistantTurn): Attributes {
  if (typeof output === "string" || output.toolCalls.length === 0) {
    return {};
  }
  return {
    [WEB_AI.TOOL_CALL_COUNT]: output.toolCalls.length,
    [WEB_AI.TOOL_CALL_NAMES]: output.toolCalls.map((call) => call.name),
  };
}

function captureOutputAttributes(
  attributes: Attributes,
  output: string | AssistantTurn,
  finishReason: string,
  config: InstrumentationConfig,
  root: boolean
): void {
  const outputMessages = encodeOutputMessages(output, finishReason);
  attributes[GEN_AI.OUTPUT_MESSAGES] = truncateAttribute(
    JSON.stringify(outputMessages),
    config.maxAttributeLength
  );
  if (config.includeMlflowPreview && root) {
    setPreview(
      attributes,
      MLFLOW_OUTPUTS,
      mlflowChatPreview(outputMessages, config.maxAttributeLength)
    );
  }
}

export function resultAttributes(result: TurnResult): Attributes {
  const { session, state, windowTokens, before, output, finishReason, config } =
    result;
  const after = result.after ?? readContextUsage(session);

  const attributes: Attributes = {
    ...contextAttributes(windowTokens, before, after),
    [GEN_AI.FINISH_REASONS]: [finishReason],
  };

  if (state.compacted) {
    attributes[GEN_AI.CONVERSATION_COMPACTED] = true;
  }
  if (before !== undefined && after !== undefined && after < before) {
    attributes[WEB_AI.CONTEXT_OVERFLOWED] = true;
    attributes[GEN_AI.CONVERSATION_COMPACTED] = true;
  }

  if (output === undefined) {
    return attributes;
  }

  Object.assign(attributes, toolCallAttributes(output));
  if (config.captureOutput) {
    captureOutputAttributes(
      attributes,
      output,
      finishReason,
      config,
      !state.exchange
    );
  }

  return attributes;
}

export interface ExchangeRequest {
  config: InstrumentationConfig;
  input: unknown;
  providerName: string;
  state: SessionState;
}

/** Attributes for the span that opens an exchange, before any turn has run. */
export function exchangeAttributes(request: ExchangeRequest): Attributes {
  const { state, input, config, providerName } = request;
  const attributes: Attributes = {
    [GEN_AI.OPERATION_NAME]: OPERATION_INVOKE_AGENT,
    [GEN_AI.PROVIDER_NAME]: providerName,
    ...promptApiAttributes(state),
    [WEB_AI.TOOL_COUNT]: state.tools.size,
    [WEB_AI.TOOL_NAMES]: [...state.tools.keys()],
  };

  if (config.captureInput) {
    captureInputAttributes(
      attributes,
      {
        config,
        input,
        providerName,
        state,
        streaming: false,
        traffic: { calls: [], responses: [] },
      },
      true
    );
  }

  return attributes;
}

export interface ExchangeResult {
  config: InstrumentationConfig;
  exchange: Exchange;
  /** The turn that ended the exchange, absent if it was abandoned. */
  output?: string | AssistantTurn;
  usageAfter?: number;
  usageBefore?: number;
  windowTokens?: number;
}

/** Attributes known only once an exchange is over. */
export function exchangeResultAttributes(result: ExchangeResult): Attributes {
  const { exchange, output, config, windowTokens, usageBefore, usageAfter } =
    result;
  const attributes: Attributes = {
    [WEB_AI.EXCHANGE_TURN_COUNT]: exchange.turns,
    [WEB_AI.EXCHANGE_TOOL_CALL_COUNT]: exchange.toolCalls,
    ...contextAttributes(windowTokens, usageBefore, usageAfter),
  };

  if (output === undefined) {
    attributes[WEB_AI.EXCHANGE_ABANDONED] = true;
    return attributes;
  }

  // The answer belongs to the exchange as much as to the turn that produced
  // it: a trace is summarised from its root.
  attributes[GEN_AI.FINISH_REASONS] = [FINISH_STOP];
  if (config.captureOutput) {
    captureOutputAttributes(attributes, output, FINISH_STOP, config, true);
  }

  return attributes;
}

export function attachOverflowListeners(
  session: LanguageModel,
  state: SessionState
): void {
  const onOverflow = () => {
    state.compacted = true;
    // With a span in flight, reconciliation attributes it to that span.
    if (state.activeSpans.size === 0) {
      state.pendingOverflow = true;
    }
  };
  session.addEventListener?.("contextoverflow", onOverflow);
  session.addEventListener?.("quotaoverflow", onOverflow);
}
