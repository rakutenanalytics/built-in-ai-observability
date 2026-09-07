import type { Attributes, Context, Span } from "@opentelemetry/api";
import {
  type AssistantTurn,
  contextAttributes,
  encodeInputMessages,
  encodeOutputMessages,
  encodeSystemInstructions,
  GEN_AI,
  type InstrumentationConfig,
  mlflowChatPreview,
  OPERATION_GENERATE_CONTENT,
  PROMPT_API_NAME,
  readContextUsage,
  type SessionTelemetryMeta,
  sessionAttributes,
  TOOL_TYPE_FUNCTION,
  type ToolCallInfo,
  type ToolTraffic,
  textFromGenAiMessages,
  textFromSystemInstructions,
  truncateAttribute,
  WEB_AI,
} from "@web-ai-otel/core";

const MLFLOW_INPUTS = "mlflow.spanInputs";
const MLFLOW_OUTPUTS = "mlflow.spanOutputs";

/**
 * A call the model asked for and the page has not answered yet. The tool runs
 * in page code, out of reach of this instrumentation, so the only way to time
 * it is to remember when the page could first run it and wait for its response.
 */
export interface PendingToolCall extends ToolCallInfo {
  /** Stands in for `callID`, which Chrome leaves empty. */
  index: number;
  turnIndex: number;
  /** Epoch ms of the turn that asked for it, so the tool span can be backdated. */
  runnableAt: number;
  /** Context of the turn that asked for the call. */
  parent: Context;
}

export interface SessionState extends SessionTelemetryMeta {
  turnIndex: number;
  compacted: boolean;
  activeSpans: Set<Span>;
  /**
   * Set when the session reports an overflow while no span is in flight, so the
   * next turn can carry it. Cleared once attributed.
   */
  pendingOverflow: boolean;
  /** Declared tools by name, so a tool span can carry its description. */
  tools: Map<string, LanguageModelToolDeclaration>;
  pendingCalls: PendingToolCall[];
  toolCallSeq: number;
  /**
   * Context of the turn that opened the current exchange. Turns carrying tool
   * responses parent to it, so one question and its tool rounds form one trace.
   */
  exchangeContext?: Context;
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
    turnIndex: 0,
    compacted: false,
    activeSpans: new Set(),
    pendingOverflow: false,
    tools: new Map(tools.map((tool) => [tool.name, tool])),
    pendingCalls: [],
    toolCallSeq: 0,
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
          type: TOOL_TYPE_FUNCTION,
          name,
          description,
          parameters: inputSchema,
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
  const text = config.includeMlflowPreview
    ? textFromSystemInstructions(instructions)
    : "";
  if (text) {
    attributes[MLFLOW_INPUTS] = mlflowChatPreview("system", text);
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
  state: SessionState;
  input: unknown;
  options?: LanguageModelPromptOptions;
  streaming: boolean;
  config: InstrumentationConfig;
  providerName: string;
  traffic: ToolTraffic;
}

function captureInputAttributes(
  attributes: Attributes,
  { input, config }: TurnRequest
): void {
  const inputMessages = encodeInputMessages(input as LanguageModelPrompt);
  attributes[GEN_AI.INPUT_MESSAGES] = truncateAttribute(
    JSON.stringify(inputMessages),
    config.maxAttributeLength
  );
  if (!config.includeMlflowPreview) {
    return;
  }
  const previewText =
    typeof input === "string"
      ? input
      : textFromGenAiMessages(
          inputMessages as unknown as Array<{
            parts?: Array<{ type: string; content?: string }>;
          }>
        );
  if (previewText) {
    attributes[MLFLOW_INPUTS] = mlflowChatPreview("user", previewText);
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
    captureInputAttributes(attributes, request);
  }

  return attributes;
}

export interface TurnResult {
  session: LanguageModel;
  state: SessionState;
  windowTokens?: number;
  before?: number;
  output?: string | AssistantTurn;
  finishReason: string;
  config: InstrumentationConfig;
  after?: number;
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
  { finishReason, config }: TurnResult
): void {
  attributes[GEN_AI.OUTPUT_MESSAGES] = truncateAttribute(
    JSON.stringify(encodeOutputMessages(output, finishReason)),
    config.maxAttributeLength
  );
  const text = typeof output === "string" ? output : output.text;
  if (config.includeMlflowPreview && text) {
    attributes[MLFLOW_OUTPUTS] = mlflowChatPreview("assistant", text);
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
    captureOutputAttributes(attributes, output, result);
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
