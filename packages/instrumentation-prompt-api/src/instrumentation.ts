import {
  context,
  type Span,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import {
  DEFAULT_CAPTURE_CONFIG,
  DEFAULT_PROVIDER_NAME,
  ERROR_TYPE,
  GEN_AI,
  type InstrumentationConfig,
  PROMPT_API_NAME,
  readContextUsage,
  readContextWindow,
  WEB_AI,
} from "@web-ai-otel/core";
import {
  attachOverflowListeners,
  createSessionAttributes,
  createSessionState,
  promptApiAttributes,
  reconcileContextOverflow,
  requestAttributes,
  resultAttributes,
  type SessionState,
} from "./session.js";

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
    monitor: (monitor: EventTarget) => {
      monitor.addEventListener("downloadprogress", (event) => {
        const { loaded } = event as ProgressEvent;
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

  const tracedPrompt = (
    input: LanguageModelPrompt,
    opts?: LanguageModelPromptOptions
  ) => {
    const windowTokens = readContextWindow(session);
    const before = readContextUsage(session);
    const attributes = requestAttributes(
      state,
      input,
      opts,
      false,
      config,
      providerName
    );

    return tracer.startActiveSpan(
      "generate_content",
      { kind: SpanKind.INTERNAL, attributes },
      async (span) => {
        state.activeSpans.add(span);
        try {
          const text = await session.prompt(input, opts);
          const after = readContextUsage(session);
          reconcileContextOverflow(span, state, before, after);
          span.setAttributes(
            resultAttributes(
              session,
              state,
              windowTokens,
              before,
              text,
              "stop",
              config,
              after
            )
          );
          span.setStatus({ code: SpanStatusCode.OK });
          return text;
        } catch (err) {
          const after = readContextUsage(session);
          reconcileContextOverflow(span, state, before, after);
          span.setAttributes(
            resultAttributes(
              session,
              state,
              windowTokens,
              before,
              undefined,
              finishReasonFor(err),
              config,
              after
            )
          );
          recordError(span, err);
          throw err;
        } finally {
          state.activeSpans.delete(span);
          span.end();
        }
      }
    );
  };

  const tracedPromptStreaming = (
    input: LanguageModelPrompt,
    opts?: LanguageModelPromptOptions
  ) => {
    const windowTokens = readContextWindow(session);
    const before = readContextUsage(session);
    const attributes = requestAttributes(
      state,
      input,
      opts,
      true,
      config,
      providerName
    );

    const span = tracer.startSpan(
      "generate_content",
      { kind: SpanKind.INTERNAL, attributes },
      context.active()
    );
    state.activeSpans.add(span);

    const startedAt = performance.now();
    let firstChunkAt: number | null = null;
    let chunkCount = 0;
    let text = "";

    const finalize = (
      finishReason: string,
      captured: string | undefined
    ): void => {
      const after = readContextUsage(session);
      reconcileContextOverflow(span, state, before, after);
      span.setAttributes(
        resultAttributes(
          session,
          state,
          windowTokens,
          before,
          captured,
          finishReason,
          config,
          after
        )
      );
    };

    const pump = async (
      controller: ReadableStreamDefaultController<string>
    ): Promise<void> => {
      const reader = session.promptStreaming(input, opts).getReader();
      let chunk = await reader.read();
      while (!chunk.done) {
        chunkCount += 1;
        firstChunkAt ??= performance.now();
        text += chunk.value;
        controller.enqueue(chunk.value);
        chunk = await reader.read();
      }
    };

    return new ReadableStream<string>({
      async start(controller) {
        try {
          await pump(controller);
          finalize("stop", text);
          span.setStatus({ code: SpanStatusCode.OK });
          controller.close();
        } catch (err) {
          finalize(finishReasonFor(err), text);
          recordError(span, err);
          controller.error(err);
        } finally {
          span.setAttribute(WEB_AI.CHUNK_COUNT, chunkCount);
          if (firstChunkAt !== null) {
            span.setAttribute(
              GEN_AI.TIME_TO_FIRST_CHUNK,
              (firstChunkAt - startedAt) / MS_PER_SECOND
            );
          }
          state.activeSpans.delete(span);
          span.end();
        }
      },
    });
  };

  const tracedDestroy = () => {
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
      // A clone keeps the conversation but starts a distinct session lineage.
      const childState = createSessionState({
        conversationId: state.conversationId,
        sessionId: crypto.randomUUID(),
        parentSessionId: state.sessionId,
      });
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
    const state = createSessionState({
      conversationId,
      sessionId: conversationId,
    });

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
