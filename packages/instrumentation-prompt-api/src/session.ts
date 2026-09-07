import type { Attributes, Span } from "@opentelemetry/api";
import {
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
  textFromGenAiMessages,
  textFromSystemInstructions,
  truncateAttribute,
  WEB_AI,
} from "@web-ai-otel/core";

const MLFLOW_INPUTS = "mlflow.spanInputs";
const MLFLOW_OUTPUTS = "mlflow.spanOutputs";

export interface SessionState extends SessionTelemetryMeta {
  turnIndex: number;
  compacted: boolean;
  activeSpans: Set<Span>;
  /**
   * Set when the session reports an overflow while no span is in flight, so the
   * next turn can carry it. Cleared once attributed.
   */
  pendingOverflow: boolean;
}

const overflowRecordedSpans = new WeakSet<Span>();

/** Identity attributes shared by every span this instrumentation emits. */
export function promptApiAttributes(state: SessionTelemetryMeta): Attributes {
  return {
    [WEB_AI.API_NAME]: PROMPT_API_NAME,
    ...sessionAttributes(state),
  };
}

export function createSessionState(meta: SessionTelemetryMeta): SessionState {
  return {
    ...meta,
    turnIndex: 0,
    compacted: false,
    activeSpans: new Set(),
    pendingOverflow: false,
  };
}

export function createSessionAttributes(
  options: LanguageModelCreateOptions,
  config: InstrumentationConfig
): Attributes {
  const attributes: Attributes = {};

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
    const instructions = encodeSystemInstructions(
      options.initialPrompts as Array<{
        role?: string;
        content:
          | string
          | Array<{ type: string; value?: unknown; content?: string }>;
      }>
    );
    if (instructions) {
      const json = truncateAttribute(
        JSON.stringify(instructions),
        config.maxAttributeLength
      );
      attributes[GEN_AI.SYSTEM_INSTRUCTIONS] = json;
      if (config.includeMlflowPreview) {
        const text = textFromSystemInstructions(instructions);
        if (text) {
          attributes[MLFLOW_INPUTS] = mlflowChatPreview("system", text);
        }
      }
    }
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

export function requestAttributes(
  state: SessionState,
  input: unknown,
  opts: LanguageModelPromptOptions | undefined,
  streaming: boolean,
  config: InstrumentationConfig,
  providerName: string
): Attributes {
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
  if (opts?.responseConstraint) {
    attributes[GEN_AI.OUTPUT_TYPE] = "json";
  }
  if (state.compacted) {
    attributes[GEN_AI.CONVERSATION_COMPACTED] = true;
  }

  if (config.captureInput) {
    const inputMessages = encodeInputMessages(input as LanguageModelPrompt);
    attributes[GEN_AI.INPUT_MESSAGES] = truncateAttribute(
      JSON.stringify(inputMessages),
      config.maxAttributeLength
    );
    if (config.includeMlflowPreview) {
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
  }

  return attributes;
}

export function resultAttributes(
  session: LanguageModel,
  state: SessionState,
  windowTokens: number | undefined,
  before: number | undefined,
  text: string | undefined,
  finish: string,
  config: InstrumentationConfig,
  after = readContextUsage(session)
): Attributes {
  const attributes: Attributes = {
    ...contextAttributes(windowTokens, before, after),
    [GEN_AI.FINISH_REASONS]: [finish],
  };

  if (state.compacted) {
    attributes[GEN_AI.CONVERSATION_COMPACTED] = true;
  }
  if (before !== undefined && after !== undefined && after < before) {
    attributes[WEB_AI.CONTEXT_OVERFLOWED] = true;
    attributes[GEN_AI.CONVERSATION_COMPACTED] = true;
  }

  if (config.captureOutput && text !== undefined) {
    attributes[GEN_AI.OUTPUT_MESSAGES] = truncateAttribute(
      JSON.stringify(encodeOutputMessages(text, finish)),
      config.maxAttributeLength
    );
    if (config.includeMlflowPreview) {
      attributes[MLFLOW_OUTPUTS] = mlflowChatPreview("assistant", text);
    }
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
