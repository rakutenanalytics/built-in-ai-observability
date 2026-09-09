import {
  type Context,
  context,
  type Span,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import {
  type AssistantTurn,
  DEFAULT_CAPTURE_CONFIG,
  DEFAULT_PROVIDER_NAME,
  ERROR_TYPE,
  FINISH_STOP,
  FINISH_TOOL_CALL,
  GEN_AI,
  type InstrumentationConfig,
  OPERATION_INVOKE_AGENT,
  PROMPT_API_NAME,
  readAssistantTurn,
  readContextUsage,
  readContextWindow,
  spanTimestamp,
  type ToolCallInfo,
  type ToolTraffic,
  toolCallFromChunk,
  toolTrafficFrom,
  WEB_AI,
} from "@web-ai-otel/core";
import {
  attachOverflowListeners,
  createSessionAttributes,
  createSessionState,
  exchangeAttributes,
  exchangeResultAttributes,
  promptApiAttributes,
  reconcileContextOverflow,
  requestAttributes,
  resultAttributes,
  type SessionState,
} from "./session.js";
import { emitToolExecutionSpans, registerToolCalls } from "./tool-spans.js";

const MS_PER_SECOND = 1000;
const DOWNLOAD_COMPLETE = 1;
const DOWNLOAD_NONE = 0;

function finishReasonFor(err: unknown): string {
  return err instanceof Error && err.name === "AbortError" ? "abort" : "error";
}

function recordError(span: Span, err: unknown): void {
  if (err instanceof Error) {
    span.recordException(err);
    span.setAttribute(ERROR_TYPE, err.name);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    return;
  }
  span.setAttribute(ERROR_TYPE, "Error");
  span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
}

/**
 * Wraps `options.monitor` so model download progress lands on the create span.
 * Only the start/finish of the download is recorded, not every progress tick.
 */
function withDownloadMonitor(
  options: LanguageModelCreateOptions,
  span: Span
): LanguageModelCreateOptions {
  const userMonitor = options.monitor;
  let firstProgressAt: number | null = null;
  let bytesMoved = false;

  return {
    ...options,
    monitor: (monitor) => {
      monitor.addEventListener("downloadprogress", (event) => {
        const { loaded } = event;
        firstProgressAt ??= performance.now();

        // A model already on disk still reports 0 then 1 back to back, so only
        // fractional progress proves a download actually ran.
        if (loaded > DOWNLOAD_NONE && loaded < DOWNLOAD_COMPLETE) {
          if (!bytesMoved) {
            bytesMoved = true;
            span.setAttribute(WEB_AI.DOWNLOAD_OBSERVED, true);
          }
          return;
        }

        if (loaded >= DOWNLOAD_COMPLETE && bytesMoved) {
          span.setAttribute(
            WEB_AI.DOWNLOAD_DURATION,
            (performance.now() - firstProgressAt) / MS_PER_SECOND
          );
          span.addEvent("web_ai.model.download_complete", {
            [WEB_AI.DOWNLOAD_PROGRESS]: loaded,
          });
        }
      });
      userMonitor?.(monitor);
    },
  };
}

export function wrapSession(
  session: LanguageModel,
  state: SessionState,
  tracer: Tracer,
  config: InstrumentationConfig,
  providerName: string
): LanguageModel {
  attachOverflowListeners(session, state);

  /**
   * Ends the exchange in flight. Called with the answering turn's output, or
   * with nothing when the page moved on without ever coming back with the tool
   * results, which leaves the exchange abandoned rather than answered.
   */
  const closeExchange = (at: number, output?: string | AssistantTurn): void => {
    const { exchange } = state;
    if (!exchange) {
      return;
    }
    state.exchange = undefined;
    state.pendingCalls = [];

    exchange.span.setAttributes(
      exchangeResultAttributes({ exchange, output, config })
    );
    exchange.span.setStatus({ code: SpanStatusCode.OK });
    // Ends where its last turn ended, so the root always covers its children.
    exchange.span.end(at);
  };

  /**
   * Opens an exchange: one `invoke_agent` span to hold every turn and tool run
   * that goes into answering a single question. Only sessions that declared
   * tools can need more than one turn, so a session without them keeps the
   * plain single-span shape.
   */
  const openExchange = (
    input: LanguageModelPrompt,
    startTime: number
  ): Context | undefined => {
    if (state.tools.size === 0) {
      return;
    }

    const span = tracer.startSpan(
      OPERATION_INVOKE_AGENT,
      {
        kind: SpanKind.INTERNAL,
        startTime,
        attributes: exchangeAttributes({
          state,
          input,
          config,
          providerName,
        }),
      },
      context.active()
    );
    const spanContext = trace.setSpan(context.active(), span);
    state.exchange = { span, context: spanContext, turns: 0, toolCalls: 0 };
    return spanContext;
  };

  /**
   * Opens a turn and decides where it hangs in the trace. A turn carrying tool
   * responses continues the exchange already in flight; anything else is a new
   * question, so it ends whatever came before and starts its own exchange.
   */
  const beginTurn = (input: LanguageModelPrompt) => {
    const at = spanTimestamp();
    const traffic = toolTrafficFrom(input);
    const continuation =
      traffic.responses.length > 0 && Boolean(state.exchange);

    if (!continuation) {
      closeExchange(at);
    }
    const parent =
      (continuation ? state.exchange?.context : openExchange(input, at)) ??
      context.active();

    // Emitted before the turn opens so a tool run sits beside the turns rather
    // than inside the one being told its result. Sharing `at` with the turn
    // about to start is what keeps the two strictly ordered.
    if (traffic.responses.length > 0) {
      emitToolExecutionSpans({
        tracer,
        state,
        responses: traffic.responses,
        config,
        providerName,
        fallbackParent: parent,
        endTime: at,
      });
    }

    if (state.exchange) {
      state.exchange.turns += 1;
    }

    return { traffic, continuation, parent, startTime: at };
  };

  const activate = (parent: Context, span: Span): Context => {
    state.activeSpans.add(span);
    return trace.setSpan(parent, span);
  };

  /**
   * Ends the turn's part in the exchange. A turn that asked for no tools is the
   * answer the exchange was waiting for; a turn that failed abandons it. Called
   * once the turn's own span has ended, so the exchange outlives what it holds.
   */
  const settleTurn = (turn: AssistantTurn | undefined, at: number): void => {
    if (state.exchange && turn) {
      state.exchange.toolCalls += turn.toolCalls.length;
    }
    if (!turn || turn.toolCalls.length === 0) {
      closeExchange(at, turn);
    }
  };

  /** Tool runs sit beside the turns, since they run between them, not within. */
  const toolParent = (fallback: Context): Context =>
    state.exchange?.context ?? fallback;

  const startTurn = (
    input: LanguageModelPrompt,
    opts: LanguageModelPromptOptions | undefined,
    streaming: boolean,
    traffic: ToolTraffic
  ) =>
    requestAttributes({
      state,
      input,
      options: opts,
      streaming,
      config,
      providerName,
      traffic,
    });

  const tracedPrompt = (
    input: LanguageModelPrompt,
    opts?: LanguageModelPromptOptions
  ): Promise<LanguageModelOutput> => {
    const { traffic, parent, startTime } = beginTurn(input);
    const windowTokens = readContextWindow(session);
    const before = readContextUsage(session);

    const span = tracer.startSpan(
      "generate_content",
      {
        kind: SpanKind.INTERNAL,
        startTime,
        attributes: startTurn(input, opts, false, traffic),
      },
      parent
    );
    const spanContext = activate(parent, span);

    return context.with(spanContext, async () => {
      let turn: AssistantTurn | undefined;
      let endedAt: number | undefined;
      try {
        const output = await session.prompt(input, opts);
        const at = spanTimestamp();
        endedAt = at;
        // A turn asking for a tool resolves to content parts, not a string.
        const assistant = readAssistantTurn(output);
        // Registered before the attributes are written so the turn's own
        // tool_call parts carry the ids the tool spans will be labelled with.
        turn = {
          text: assistant.text,
          toolCalls: registerToolCalls(
            state,
            assistant.toolCalls,
            toolParent(spanContext),
            at
          ),
        };
        const after = readContextUsage(session);
        reconcileContextOverflow(span, state, before, after);
        span.setAttributes(
          resultAttributes({
            session,
            state,
            windowTokens,
            before,
            output: turn,
            finishReason:
              turn.toolCalls.length > 0 ? FINISH_TOOL_CALL : FINISH_STOP,
            config,
            after,
          })
        );
        span.setStatus({ code: SpanStatusCode.OK });
        return output;
      } catch (err) {
        const after = readContextUsage(session);
        reconcileContextOverflow(span, state, before, after);
        span.setAttributes(
          resultAttributes({
            session,
            state,
            windowTokens,
            before,
            finishReason: finishReasonFor(err),
            config,
            after,
          })
        );
        recordError(span, err);
        throw err;
      } finally {
        // Unset only when the turn failed before it could be timed.
        const at = endedAt ?? spanTimestamp();
        state.activeSpans.delete(span);
        span.end(at);
        settleTurn(turn, at);
      }
    });
  };

  const tracedPromptStreaming = (
    input: LanguageModelPrompt,
    opts?: LanguageModelPromptOptions
  ): ReadableStream<LanguageModelStreamChunk> => {
    const { traffic, parent, startTime } = beginTurn(input);
    const windowTokens = readContextWindow(session);
    const before = readContextUsage(session);

    const span = tracer.startSpan(
      "generate_content",
      {
        kind: SpanKind.INTERNAL,
        startTime,
        attributes: startTurn(input, opts, true, traffic),
      },
      parent
    );
    const spanContext = activate(parent, span);

    const startedAt = performance.now();
    let firstChunkAt: number | null = null;
    let chunkCount = 0;
    let text = "";
    const toolCalls: ToolCallInfo[] = [];

    const finalize = (output: AssistantTurn, finishReason: string): void => {
      const after = readContextUsage(session);
      reconcileContextOverflow(span, state, before, after);
      span.setAttributes(
        resultAttributes({
          session,
          state,
          windowTokens,
          before,
          output,
          finishReason,
          config,
          after,
        })
      );
    };

    const pump = async (
      controller: ReadableStreamDefaultController<LanguageModelStreamChunk>
    ): Promise<void> => {
      const reader = session.promptStreaming(input, opts).getReader();
      let chunk = await reader.read();
      while (!chunk.done) {
        chunkCount += 1;
        firstChunkAt ??= performance.now();

        // The stream is heterogeneous: text arrives as bare strings, and each
        // tool call as its own structured chunk. Both are forwarded untouched,
        // so the page's own tool loop still sees exactly what Chrome sent.
        if (typeof chunk.value === "string") {
          text += chunk.value;
        } else {
          const call = toolCallFromChunk(chunk.value);
          if (call) {
            toolCalls.push(call);
          }
        }

        controller.enqueue(chunk.value);
        chunk = await reader.read();
      }
    };

    return new ReadableStream<LanguageModelStreamChunk>({
      async start(controller) {
        let turn: AssistantTurn | undefined;
        let endedAt: number | undefined;
        try {
          await context.with(spanContext, () => pump(controller));
          const at = spanTimestamp();
          endedAt = at;
          // Registered before the attributes are written so the turn's own
          // tool_call parts carry the ids the tool spans will be labelled with.
          turn = {
            text,
            toolCalls: registerToolCalls(
              state,
              toolCalls,
              toolParent(spanContext),
              at
            ),
          };
          finalize(
            turn,
            turn.toolCalls.length > 0 ? FINISH_TOOL_CALL : FINISH_STOP
          );
          span.setStatus({ code: SpanStatusCode.OK });
          controller.close();
        } catch (err) {
          finalize({ text, toolCalls }, finishReasonFor(err));
          recordError(span, err);
          controller.error(err);
        } finally {
          // Unset only when the turn failed before it could be timed.
          const at = endedAt ?? spanTimestamp();
          span.setAttribute(WEB_AI.CHUNK_COUNT, chunkCount);
          if (firstChunkAt !== null) {
            span.setAttribute(
              GEN_AI.TIME_TO_FIRST_CHUNK,
              (firstChunkAt - startedAt) / MS_PER_SECOND
            );
          }
          state.activeSpans.delete(span);
          span.end(at);
          settleTurn(turn, at);
        }
      },
    });
  };

  const tracedDestroy = () => {
    // Destroying mid-exchange means the tool results are never coming.
    closeExchange(spanTimestamp());

    const span = tracer.startSpan("web_ai.destroy_session", {
      kind: SpanKind.INTERNAL,
      attributes: promptApiAttributes(state),
    });
    try {
      session.destroy();
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      recordError(span, err);
      throw err;
    } finally {
      span.end();
    }
  };

  const tracedClone = async (opts?: LanguageModelCloneOptions) => {
    const span = tracer.startSpan("web_ai.clone_session", {
      kind: SpanKind.INTERNAL,
      attributes: promptApiAttributes(state),
    });
    try {
      const cloned = await session.clone(opts);
      // A clone keeps the conversation and the tools, but starts a distinct
      // session lineage.
      const childState = createSessionState(
        {
          conversationId: state.conversationId,
          sessionId: crypto.randomUUID(),
          parentSessionId: state.sessionId,
        },
        [...state.tools.values()]
      );
      span.setStatus({ code: SpanStatusCode.OK });
      return wrapSession(cloned, childState, tracer, config, providerName);
    } catch (err) {
      recordError(span, err);
      throw err;
    } finally {
      span.end();
    }
  };

  const overrides: Record<string, unknown> = {
    prompt: tracedPrompt,
    promptStreaming: tracedPromptStreaming,
    destroy: tracedDestroy,
    clone: tracedClone,
  };

  return new Proxy(session, {
    get(target, prop) {
      if (typeof prop === "string" && prop in overrides) {
        return overrides[prop];
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as LanguageModel;
}

export interface PromptInstrumentationOptions
  extends Partial<InstrumentationConfig> {
  tracerProvider?: { getTracer: (name: string, version?: string) => Tracer };
  tracerName?: string;
  tracerVersion?: string;
  providerName?: string;
}

type CreateFn = typeof LanguageModel.create;
type AvailabilityFn = typeof LanguageModel.availability;

export class PromptApiInstrumentation {
  private readonly config: InstrumentationConfig;
  private readonly tracer: Tracer;
  private readonly providerName: string;
  private enabled = false;
  private originalCreate?: CreateFn;
  private originalAvailability?: AvailabilityFn;

  constructor(options: PromptInstrumentationOptions = {}) {
    const {
      tracerProvider,
      tracerName,
      tracerVersion,
      providerName,
      ...captureConfig
    } = options;

    this.config = { ...DEFAULT_CAPTURE_CONFIG, ...captureConfig };
    this.providerName = providerName ?? DEFAULT_PROVIDER_NAME;
    this.tracer = (tracerProvider ?? trace.getTracerProvider()).getTracer(
      tracerName ?? "@web-ai-otel/instrumentation-prompt-api",
      tracerVersion ?? "0.1.0"
    );
  }

  private async tracedCreate(
    original: CreateFn,
    options: LanguageModelCreateOptions
  ): Promise<LanguageModel> {
    const conversationId = crypto.randomUUID();
    const state = createSessionState(
      { conversationId, sessionId: conversationId },
      options.tools
    );

    const span = this.tracer.startSpan("web_ai.create_session", {
      kind: SpanKind.INTERNAL,
      attributes: {
        ...promptApiAttributes(state),
        ...createSessionAttributes(options, this.config),
      },
    });

    try {
      const session = await original.call(
        LanguageModel,
        withDownloadMonitor(options, span)
      );
      const windowTokens = readContextWindow(session);
      if (windowTokens !== undefined) {
        span.setAttribute(WEB_AI.CONTEXT_WINDOW, windowTokens);
      }
      span.setStatus({ code: SpanStatusCode.OK });
      return wrapSession(
        session,
        state,
        this.tracer,
        this.config,
        this.providerName
      );
    } catch (err) {
      recordError(span, err);
      throw err;
    } finally {
      span.end();
    }
  }

  private async tracedAvailability(
    original: AvailabilityFn,
    options: LanguageModelCreateOptions
  ): Promise<Availability> {
    const span = this.tracer.startSpan("web_ai.check_availability", {
      kind: SpanKind.INTERNAL,
      attributes: {
        [WEB_AI.API_NAME]: PROMPT_API_NAME,
        ...createSessionAttributes(options, this.config),
      },
    });
    try {
      const status = await original.call(LanguageModel, options);
      span.setAttribute(WEB_AI.AVAILABILITY_STATUS, status);
      span.setStatus({ code: SpanStatusCode.OK });
      return status;
    } catch (err) {
      recordError(span, err);
      throw err;
    } finally {
      span.end();
    }
  }

  enable(): void {
    if (this.enabled || !("LanguageModel" in globalThis)) {
      return;
    }

    const originalCreate = LanguageModel.create;
    const originalAvailability = LanguageModel.availability;
    this.originalCreate = originalCreate;
    this.originalAvailability = originalAvailability;

    LanguageModel.create = (options = {}) =>
      this.tracedCreate(originalCreate, options);
    LanguageModel.availability = (options = {}) =>
      this.tracedAvailability(originalAvailability, options);

    this.enabled = true;
  }

  disable(): void {
    if (!this.enabled) {
      return;
    }
    if (this.originalCreate) {
      LanguageModel.create = this.originalCreate;
    }
    if (this.originalAvailability) {
      LanguageModel.availability = this.originalAvailability;
    }
    this.enabled = false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}
