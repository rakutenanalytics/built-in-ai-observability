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
 * Remembers the calls a turn asked for, and hands each one an id. They stay
 * pending until the page sends results back, which is the only moment their
 * duration becomes known.
 *
 * Chrome leaves `callID` empty, so a synthetic id is filled in: without one,
 * nothing ties the `tool_call` part recorded on the turn to the `execute_tool`
 * span that answers it. The calls are returned with those ids so the turn can
 * describe itself in the same terms as the spans that follow.
 *
 * Every call of a turn is stamped with `runnableAt`, the moment the turn
 * finished, not the moment it appeared. While streaming, a call arrives as soon
 * as the model emits it, but the page cannot act on it until the stream closes,
 * so stamping on arrival would charge the earliest call for the rest of the
 * generation. That time already belongs to the `generate_content` span.
 */
export function registerToolCalls(
  state: SessionState,
  calls: ToolCallInfo[],
  parent: Context,
  runnableAt: number
): ToolCallInfo[] {
  return calls.map((call) => {
    state.toolCallSeq += 1;
    const identified: ToolCallInfo = {
      ...call,
      id: call.id || `${state.sessionId}-${state.toolCallSeq}`,
    };
    state.pendingCalls.push({
      ...identified,
      index: state.toolCallSeq,
      turnIndex: state.turnIndex,
      runnableAt,
      parent,
    });
    return identified;
  });
}

/**
 * Finds the call a response answers. `callID` would say so, but Chrome leaves
 * it empty on both sides, so the name is matched instead and identical names
 * fall back to the order they were requested in.
 */
function takePendingCall(
  state: SessionState,
  response: ToolResponseInfo
): PendingToolCall | undefined {
  const { pendingCalls } = state;
  const byId = response.id
    ? pendingCalls.findIndex((call) => call.id === response.id)
    : -1;
  const at =
    byId >= 0
      ? byId
      : pendingCalls.findIndex((call) => call.name === response.name);

  // A response that matches nothing must not consume some other call's record,
  // or the next response inherits its arguments and its start time.
  if (at < 0) {
    return;
  }
  return pendingCalls.splice(at, 1)[0];
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

  // The response's own id when the model set one, otherwise the id handed to
  // the call, which is what the turn's tool_call part carries.
  const callId = response.id || pending?.id;
  if (callId) {
    attributes[GEN_AI.TOOL_CALL_ID] = callId;
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
    attributes[GEN_AI.TOOL_CALL_ARGUMENTS] = safeJson(
      pending.arguments,
      config.maxAttributeLength
    );
  }
  // The spec records a result only for a call that succeeded; a failure is left
  // to `error.type` and the span status.
  if (config.captureOutput && response.result !== undefined) {
    attributes[GEN_AI.TOOL_CALL_RESULT] = safeJson(
      response.result,
      config.maxAttributeLength
    );
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
  /** Where every span ends: the instant the turn consuming them begins. */
  endTime: number;
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
  const {
    tracer,
    state,
    responses,
    config,
    providerName,
    fallbackParent,
    endTime,
  } = options;

  for (const response of responses) {
    const pending = takePendingCall(state, response);
    const name = response.name || pending?.name || UNKNOWN_TOOL;

    const span = tracer.startSpan(
      `${OPERATION_EXECUTE_TOOL} ${name}`,
      {
        kind: SpanKind.INTERNAL,
        // An unmatched response has no known start, so it collapses onto the
        // moment it arrived rather than borrowing another call's clock.
        startTime: pending?.runnableAt ?? endTime,
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
