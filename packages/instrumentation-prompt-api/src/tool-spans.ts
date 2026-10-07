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
} from "@built-in-ai-obs/core";
import {
  type Attributes,
  type Context,
  SpanKind,
  SpanStatusCode,
  type Tracer,
} from "@opentelemetry/api";
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
    // Tool arguments are not always JSON.
  }
}

/**
 * Remembers the calls a turn asked for. They stay pending until the page sends
 * results back, which is the only moment their duration becomes known.
 *
 * The spec requires a non-empty `callId`, but Chrome 157 still sends `""`. A
 * call without one is given an id here, so the `tool_call` part recorded on the
 * turn and the `execute_tool` span that answers it can still be joined. The
 * calls are returned with those ids so the turn describes itself in the same
 * terms as the spans that follow. A real `callId` is always kept as is.
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
    const generatedId = !call.id;
    if (generatedId) {
      state.generatedCallSeq += 1;
    }
    const identified: ToolCallInfo = {
      ...call,
      id: call.id || `${state.sessionId}-${state.generatedCallSeq}`,
    };
    state.pendingCalls.push({
      ...identified,
      generatedId,
      parent,
      runnableAt,
      turnIndex: state.turnIndex,
    });
    return identified;
  });
}

/**
 * Finds the call a response answers, by the `callId` both carry.
 *
 * A response without one can only be answering a call that had none either, so
 * it is matched by name among those, oldest first. A response with an id that
 * matches nothing gets no call: borrowing one by name would hand it another
 * call's arguments and start time.
 */
function takePendingCall(
  state: SessionState,
  response: ToolResponseInfo
): PendingToolCall | undefined {
  const { pendingCalls } = state;
  const at = response.id
    ? pendingCalls.findIndex((call) => call.id === response.id)
    : pendingCalls.findIndex(
        (call) => call.generatedId && call.name === response.name
      );
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

  // The response's own id when it has one, otherwise the id given to the call,
  // which is what the turn's tool_call part carries.
  const callId = response.id || pending?.id;
  if (callId) {
    attributes[GEN_AI.TOOL_CALL_ID] = callId;
  }
  if (pending) {
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
  config: InstrumentationConfig;
  /** Where every span ends: the instant the turn consuming them begins. */
  endTime: number;
  /** Used when no pending call matches, so the span still joins the trace. */
  fallbackParent: Context;
  providerName: string;
  responses: ToolResponseInfo[];
  state: SessionState;
  tracer: Tracer;
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
        attributes: toolSpanAttributes(
          state,
          response,
          pending,
          config,
          providerName
        ),
        kind: SpanKind.INTERNAL,
        // An unmatched response has no known start, so it collapses onto the
        // moment it arrived rather than borrowing another call's clock.
        startTime: pending?.runnableAt ?? endTime,
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
