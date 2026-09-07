import {
  type Attributes,
  type Context,
  SpanKind,
  SpanStatusCode,
  type Tracer,
} from "@opentelemetry/api";
import {
  ERROR_TYPE,
  GEN_AI,
  type InstrumentationConfig,
  OPERATION_EXECUTE_TOOL,
  TOOL_TYPE_FUNCTION,
  type ToolCallInfo,
  type ToolResponseInfo,
  truncateAttribute,
  WEB_AI,
} from "@web-ai-otel/core";
import {
  type PendingToolCall,
  promptApiAttributes,
  type SessionState,
} from "./session.js";

const UNKNOWN_TOOL = "unknown";

/** Tool payloads come from the model and the page, so neither is trusted. */
function safeJson(value: unknown, maxLength: number): string | undefined {
  try {
    return truncateAttribute(JSON.stringify(value), maxLength);
  } catch {
    return;
  }
}

/**
 * Remembers the calls a turn asked for. They stay pending until the page sends
 * results back, which is the only moment their duration becomes known.
 *
 * Every call of a turn is stamped with the moment the turn finished, not the
 * moment it appeared. While streaming, a call arrives as soon as the model
 * emits it, but the page cannot act on it until the stream closes, so stamping
 * on arrival would charge the earliest call for the rest of the generation.
 * That time already belongs to the `generate_content` span.
 */
export function registerToolCalls(
  state: SessionState,
  calls: ToolCallInfo[],
  parent: Context
): void {
  const turnEndedAt = Date.now();
  for (const call of calls) {
    state.toolCallSeq += 1;
    state.pendingCalls.push({
      ...call,
      index: state.toolCallSeq,
      turnIndex: state.turnIndex,
      runnableAt: turnEndedAt,
      parent,
    });
  }
}

/**
 * Finds the call a response answers. `callID` would say so, but Chrome leaves
 * it empty, so the name is matched instead and identical names fall back to the
 * order they were requested in.
 */
function takePendingCall(
  state: SessionState,
  response: ToolResponseInfo
): PendingToolCall | undefined {
  const { pendingCalls } = state;
  const byId = response.id
    ? pendingCalls.findIndex((call) => call.id === response.id)
    : -1;
  const byName = pendingCalls.findIndex((call) => call.name === response.name);
  const at = byId >= 0 ? byId : byName;
  return pendingCalls.splice(at >= 0 ? at : 0, 1)[0];
}

function toolSpanAttributes(
  state: SessionState,
  response: ToolResponseInfo,
  pending: PendingToolCall | undefined,
  config: InstrumentationConfig,
  providerName: string
): Attributes {
  const name = response.name || pending?.name || UNKNOWN_TOOL;
  const attributes: Attributes = {
    [GEN_AI.OPERATION_NAME]: OPERATION_EXECUTE_TOOL,
    [GEN_AI.PROVIDER_NAME]: providerName,
    ...promptApiAttributes(state),
    [GEN_AI.TOOL_NAME]: name,
    [GEN_AI.TOOL_TYPE]: TOOL_TYPE_FUNCTION,
  };

  if (response.id) {
    attributes[GEN_AI.TOOL_CALL_ID] = response.id;
  }
  if (pending) {
    attributes[WEB_AI.TOOL_CALL_INDEX] = pending.index;
    attributes[WEB_AI.TURN_INDEX] = pending.turnIndex;
  }

  const description = state.tools.get(name)?.description;
  if (description) {
    attributes[GEN_AI.TOOL_DESCRIPTION] = description;
  }
  if (config.captureInput && pending?.arguments !== undefined) {
    attributes[WEB_AI.TOOL_CALL_ARGUMENTS] = safeJson(
      pending.arguments,
      config.maxAttributeLength
    );
  }
  if (config.captureOutput && response.result !== undefined) {
    attributes[WEB_AI.TOOL_RESULT] = safeJson(
      response.result,
      config.maxAttributeLength
    );
  }
  if (response.errorMessage !== undefined) {
    attributes[WEB_AI.TOOL_FAILED] = true;
  }

  return attributes;
}

export interface ToolSpanOptions {
  tracer: Tracer;
  state: SessionState;
  responses: ToolResponseInfo[];
  config: InstrumentationConfig;
  providerName: string;
  /** Used when no pending call matches, so the span still joins the trace. */
  fallbackParent: Context;
}

/**
 * Emits one `execute_tool` span per response received.
 *
 * The tool itself runs in page code, which this instrumentation never sees, so
 * the span is reconstructed after the fact: it spans the turn that asked for
 * the call to the moment the page answered. That covers the page's own tool
 * loop as well as the tool, which is the wait a developer can act on.
 */
export function emitToolExecutionSpans(options: ToolSpanOptions): void {
  const { tracer, state, responses, config, providerName, fallbackParent } =
    options;
  const endTime = Date.now();

  for (const response of responses) {
    const pending = takePendingCall(state, response);
    const name = response.name || pending?.name || UNKNOWN_TOOL;

    const span = tracer.startSpan(
      `${OPERATION_EXECUTE_TOOL} ${name}`,
      {
        kind: SpanKind.INTERNAL,
        startTime: pending?.runnableAt,
        attributes: toolSpanAttributes(
          state,
          response,
          pending,
          config,
          providerName
        ),
      },
      pending?.parent ?? fallbackParent
    );

    if (response.errorMessage === undefined) {
      span.setStatus({ code: SpanStatusCode.OK });
    } else {
      span.setAttribute(ERROR_TYPE, "ToolError");
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: response.errorMessage,
      });
    }
    span.end(endTime);
  }
}
