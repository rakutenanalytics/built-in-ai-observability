import type { HrTime, TracerProvider } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PromptApiInstrumentation,
  type PromptInstrumentationOptions,
} from "../src/instrumentation.js";

const CONTEXT_WINDOW = 4096;
const SPAN_STATUS_ERROR = 2;

type MockSessionOverrides = Record<string, unknown>;

function streamOf(
  chunks: LanguageModelStreamChunk[]
): ReadableStream<LanguageModelStreamChunk> {
  return new ReadableStream<LanguageModelStreamChunk>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

/** A stream that pauses mid-turn, the way a model that keeps generating does. */
function slowStream(
  before: LanguageModelStreamChunk[],
  pauseMs: number,
  after: LanguageModelStreamChunk[]
): ReadableStream<LanguageModelStreamChunk> {
  return new ReadableStream<LanguageModelStreamChunk>({
    async start(controller) {
      for (const chunk of before) {
        controller.enqueue(chunk);
      }
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
      for (const chunk of after) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

const NANOS_PER_MS = 1e6;
const MS_PER_SECOND = 1000;

function durationMs(span: ReadableSpan | undefined): number {
  const [seconds, nanos] = span?.duration ?? [0, 0];
  return seconds * MS_PER_SECOND + nanos / NANOS_PER_MS;
}

function millis([seconds, nanos]: HrTime): number {
  return seconds * MS_PER_SECOND + nanos / NANOS_PER_MS;
}

const startedAt = (span: ReadableSpan | undefined): number =>
  millis(span?.startTime ?? [0, 0]);

const endedAt = (span: ReadableSpan | undefined): number =>
  millis(span?.endTime ?? [0, 0]);

/**
 * The real tool interfaces keep every field on the prototype, so `Object.keys()`
 * sees nothing. These doubles do the same, which is what the encoders have to
 * cope with.
 */
function toolCall(
  name: string,
  args: Record<string, unknown>,
  callID = ""
): LanguageModelToolCall {
  return Object.create({
    callID,
    name,
    arguments: args,
  }) as LanguageModelToolCall;
}

function toolSuccess(
  name: string,
  value: unknown,
  callID = ""
): LanguageModelToolSuccess {
  return Object.create({
    callID,
    name,
    result: [{ type: "object", value }],
  }) as LanguageModelToolSuccess;
}

function toolError(
  name: string,
  errorMessage: string,
  callID = ""
): LanguageModelToolError {
  return Object.create({
    callID,
    name,
    errorMessage,
  }) as LanguageModelToolError;
}

function toolCallChunk(
  call: LanguageModelToolCall
): LanguageModelToolCallContent {
  return { type: "tool-call", value: call };
}

function toolResponseChunk(
  response: LanguageModelToolResponse
): LanguageModelToolResponseContent {
  return { type: "tool-response", value: response };
}

function toolResponseTurn(
  ...responses: LanguageModelToolResponse[]
): LanguageModelMessage[] {
  // Tool responses travel as user content: there is no `tool` role.
  return [{ role: "user", content: responses.map(toolResponseChunk) }];
}

const WEATHER_TOOL: LanguageModelToolDeclaration = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};

function createMockSession(overrides: MockSessionOverrides = {}) {
  const listeners = new Map<string, Set<() => void>>();
  const session = {
    contextWindow: CONTEXT_WINDOW,
    contextUsage: 100,
    addEventListener: (type: string, fn: () => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    /** Test hook: fire a session event such as "contextoverflow". */
    emit: (type: string) => {
      for (const fn of listeners.get(type) ?? []) {
        fn();
      }
    },
    prompt: vi.fn(
      (input: LanguageModelPrompt): Promise<LanguageModelOutput> =>
        Promise.resolve(`reply:${String(input)}`)
    ),
    promptStreaming: vi.fn(
      (input: LanguageModelPrompt): ReadableStream<LanguageModelStreamChunk> =>
        streamOf(["stream:", String(input)])
    ),
    destroy: vi.fn(),
    clone: vi.fn(() => Promise.resolve(createMockSession())),
    ...overrides,
  };
  return session;
}

async function collect(
  stream: ReadableStream<LanguageModelStreamChunk>
): Promise<LanguageModelStreamChunk[]> {
  const reader = stream.getReader();
  const chunks: LanguageModelStreamChunk[] = [];
  let chunk = await reader.read();
  while (!chunk.done) {
    chunks.push(chunk.value);
    chunk = await reader.read();
  }
  return chunks;
}

async function drain(
  stream: ReadableStream<LanguageModelStreamChunk>
): Promise<string> {
  const chunks = await collect(stream);
  return chunks.filter((chunk) => typeof chunk === "string").join("");
}

describe("PromptApiInstrumentation", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let instrumentation: PromptApiInstrumentation;
  let mockSession: ReturnType<typeof createMockSession>;
  let originalCreate: typeof LanguageModel.create;
  let createSpy: ReturnType<typeof vi.fn>;

  const spanNamed = (name: string): ReadableSpan | undefined =>
    exporter.getFinishedSpans().find((span) => span.name === name);

  const setup = (options: PromptInstrumentationOptions = {}) => {
    instrumentation = new PromptApiInstrumentation({
      tracerProvider: provider as unknown as TracerProvider,
      captureInput: true,
      captureOutput: true,
      ...options,
    });
    instrumentation.enable();
  };

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });

    mockSession = createMockSession();
    createSpy = vi.fn(() => Promise.resolve(mockSession));
    (globalThis as Record<string, unknown>).LanguageModel = {
      create: createSpy,
      availability: vi.fn(() => Promise.resolve("available")),
    };
    originalCreate = LanguageModel.create;
    setup();
  });

  afterEach(async () => {
    instrumentation.disable();
    (globalThis as Record<string, unknown>).LanguageModel = undefined;
    await provider.shutdown();
  });

  it("instruments create and prompt", async () => {
    const session = await LanguageModel.create({
      expectedInputs: [{ type: "text", languages: ["en"] }],
    });
    await expect(session.prompt("hello")).resolves.toBe("reply:hello");

    const createSpan = spanNamed("web_ai.create_session");
    expect(createSpan?.attributes["web_ai.api.name"]).toBe("LanguageModel");
    expect(createSpan?.attributes["web_ai.context.window_tokens"]).toBe(
      CONTEXT_WINDOW
    );

    const promptSpan = spanNamed("generate_content");
    expect(promptSpan?.attributes["gen_ai.operation.name"]).toBe(
      "generate_content"
    );
    expect(promptSpan?.attributes["gen_ai.provider.name"]).toBe(
      "google.chrome"
    );
    expect(promptSpan?.attributes["web_ai.api.name"]).toBe("LanguageModel");
    expect(promptSpan?.attributes["web_ai.conversation.turn_index"]).toBe(1);
  });

  it("shares one conversation id across turns and increments turn index", async () => {
    const session = await LanguageModel.create();
    await session.prompt("one");
    await session.prompt("two");

    const turns = exporter
      .getFinishedSpans()
      .filter((span) => span.name === "generate_content");
    expect(turns).toHaveLength(2);
    expect(
      turns.map((s) => s.attributes["web_ai.conversation.turn_index"])
    ).toEqual([1, 2]);

    const conversationIds = new Set(
      turns.map((s) => s.attributes["gen_ai.conversation.id"])
    );
    expect(conversationIds.size).toBe(1);
  });

  it("captures input and output messages when enabled", async () => {
    const session = await LanguageModel.create();
    await session.prompt("hello");

    const span = spanNamed("generate_content");
    expect(String(span?.attributes["gen_ai.input.messages"])).toContain(
      "hello"
    );
    expect(String(span?.attributes["gen_ai.output.messages"])).toContain(
      "reply:hello"
    );
  });

  it("omits message content when capture is disabled", async () => {
    instrumentation.disable();
    exporter.reset();
    setup({ captureInput: false, captureOutput: false });

    const session = await LanguageModel.create();
    await session.prompt("secret");

    const span = spanNamed("generate_content");
    expect(span?.attributes["gen_ai.input.messages"]).toBeUndefined();
    expect(span?.attributes["gen_ai.output.messages"]).toBeUndefined();
  });

  it("records non-text prompt parts by modality only", async () => {
    const session = await LanguageModel.create();
    await session.prompt([
      {
        role: "user",
        content: [
          { type: "text", value: "describe" },
          { type: "image", value: "binary-blob" },
        ],
      },
    ]);

    const encoded = String(
      spanNamed("generate_content")?.attributes["gen_ai.input.messages"]
    );
    expect(encoded).toContain("describe");
    expect(encoded).toContain("redacted");
    expect(encoded).not.toContain("binary-blob");
  });

  it("instruments promptStreaming with chunk count and TTFT", async () => {
    const session = await LanguageModel.create();
    const text = await drain(session.promptStreaming("hi"));
    expect(text).toBe("stream:hi");

    const span = spanNamed("generate_content");
    expect(span?.attributes["gen_ai.request.stream"]).toBe(true);
    expect(span?.attributes["web_ai.stream.chunk_count"]).toBe(2);
    expect(span?.attributes["gen_ai.response.time_to_first_chunk"]).toBeTypeOf(
      "number"
    );
    expect(String(span?.attributes["gen_ai.output.messages"])).toContain(
      "stream:hi"
    );
  });

  it("records errors from prompt and rethrows", async () => {
    mockSession.prompt = vi.fn(() => Promise.reject(new Error("model failed")));
    const session = await LanguageModel.create();

    await expect(session.prompt("boom")).rejects.toThrow("model failed");

    const span = spanNamed("generate_content");
    expect(span?.status.code).toBe(SPAN_STATUS_ERROR);
    expect(span?.attributes["error.type"]).toBe("Error");
    expect(span?.attributes["gen_ai.response.finish_reasons"]).toEqual([
      "error",
    ]);
  });

  it("marks aborted prompts with an abort finish reason", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    mockSession.prompt = vi.fn(() => Promise.reject(abortError));
    const session = await LanguageModel.create();

    await expect(session.prompt("boom")).rejects.toThrow("aborted");
    expect(
      spanNamed("generate_content")?.attributes[
        "gen_ai.response.finish_reasons"
      ]
    ).toEqual(["abort"]);
  });

  it("records a failing create and rethrows", async () => {
    instrumentation.disable();
    exporter.reset();
    createSpy.mockImplementation(() => Promise.reject(new Error("no model")));
    setup();

    await expect(LanguageModel.create()).rejects.toThrow("no model");
    expect(spanNamed("web_ai.create_session")?.status.code).toBe(
      SPAN_STATUS_ERROR
    );
  });

  it("flags context overflow reported by the session", async () => {
    const session = await LanguageModel.create();
    mockSession.emit("contextoverflow");
    await session.prompt("after overflow");

    const span = spanNamed("generate_content");
    expect(span?.attributes["web_ai.context.overflowed"]).toBe(true);
    expect(span?.attributes["gen_ai.conversation.compacted"]).toBe(true);
    expect(span?.events.map((e) => e.name)).toContain(
      "web_ai.context_overflow"
    );
  });

  it("instruments availability", async () => {
    await expect(LanguageModel.availability()).resolves.toBe("available");
    const span = spanNamed("web_ai.check_availability");
    expect(span?.attributes["web_ai.availability.status"]).toBe("available");
    expect(span?.attributes["web_ai.api.name"]).toBe("LanguageModel");
  });

  it("instruments destroy", async () => {
    const session = await LanguageModel.create();
    session.destroy();
    expect(mockSession.destroy).toHaveBeenCalled();
    expect(spanNamed("web_ai.destroy_session")).toBeDefined();
  });

  it("keeps the conversation but starts a new session id on clone", async () => {
    const session = await LanguageModel.create();
    const cloned = await session.clone();
    await cloned.prompt("from clone");

    const createSpan = spanNamed("web_ai.create_session");
    const cloneTurn = spanNamed("generate_content");
    expect(spanNamed("web_ai.clone_session")).toBeDefined();
    expect(cloneTurn?.attributes["gen_ai.conversation.id"]).toBe(
      createSpan?.attributes["gen_ai.conversation.id"]
    );
    expect(cloneTurn?.attributes["web_ai.session.parent_id"]).toBe(
      createSpan?.attributes["web_ai.session.id"]
    );
  });

  it("reports model download progress on the create span", async () => {
    instrumentation.disable();
    exporter.reset();
    createSpy.mockImplementation((options?: LanguageModelCreateOptions) => {
      const monitor = new EventTarget();
      options?.monitor?.(monitor);
      monitor.dispatchEvent(
        Object.assign(new Event("downloadprogress"), { loaded: 0.5 })
      );
      monitor.dispatchEvent(
        Object.assign(new Event("downloadprogress"), { loaded: 1 })
      );
      return Promise.resolve(mockSession);
    });
    setup();

    await LanguageModel.create();

    const span = spanNamed("web_ai.create_session");
    expect(span?.attributes["web_ai.model.download_observed"]).toBe(true);
    expect(span?.attributes["web_ai.model.download_duration"]).toBeTypeOf(
      "number"
    );
    expect(span?.events.map((e) => e.name)).toContain(
      "web_ai.model.download_complete"
    );
  });

  it("does not report a download when the model is already on disk", async () => {
    // Chrome emits loaded 0 then 1 back to back for a cached model.
    instrumentation.disable();
    exporter.reset();
    createSpy.mockImplementation((options?: LanguageModelCreateOptions) => {
      const monitor = new EventTarget();
      options?.monitor?.(monitor);
      monitor.dispatchEvent(
        Object.assign(new Event("downloadprogress"), { loaded: 0 })
      );
      monitor.dispatchEvent(
        Object.assign(new Event("downloadprogress"), { loaded: 1 })
      );
      return Promise.resolve(mockSession);
    });
    setup();

    await LanguageModel.create();

    const span = spanNamed("web_ai.create_session");
    expect(span?.attributes["web_ai.model.download_observed"]).toBeUndefined();
    expect(span?.attributes["web_ai.model.download_duration"]).toBeUndefined();
    expect(span?.events.map((e) => e.name)).not.toContain(
      "web_ai.model.download_complete"
    );
  });

  it("passes through untouched session members", async () => {
    const session = await LanguageModel.create();
    expect(session.contextWindow).toBe(CONTEXT_WINDOW);
  });

  it("restores the original API on disable", () => {
    instrumentation.disable();
    expect(LanguageModel.create).toBe(originalCreate);
    expect(instrumentation.isEnabled()).toBe(false);
  });

  it("is idempotent across repeated enable calls", () => {
    const patched = LanguageModel.create;
    instrumentation.enable();
    expect(LanguageModel.create).toBe(patched);
  });

  describe("tool calling", () => {
    const toolSpans = () =>
      exporter
        .getFinishedSpans()
        .filter((span) => span.name.startsWith("execute_tool"));

    const turnSpans = () =>
      exporter
        .getFinishedSpans()
        .filter((span) => span.name === "generate_content");

    it("records declared tools on the create span", async () => {
      await LanguageModel.create({ tools: [WEATHER_TOOL] });

      const span = spanNamed("web_ai.create_session");
      expect(span?.attributes["web_ai.tool.count"]).toBe(1);
      expect(span?.attributes["web_ai.tool.names"]).toEqual(["get_weather"]);
      expect(String(span?.attributes["gen_ai.tool.definitions"])).toContain(
        WEATHER_TOOL.description
      );
    });

    it("records a tool call that prompt returns instead of text", async () => {
      mockSession.prompt = vi.fn(() =>
        Promise.resolve([
          toolCallChunk(toolCall("get_weather", { city: "Tokyo" })),
        ])
      );
      const session = await LanguageModel.create({ tools: [WEATHER_TOOL] });
      await session.prompt("weather in Tokyo?");

      const span = spanNamed("generate_content");
      expect(span?.attributes["web_ai.tool.call_count"]).toBe(1);
      expect(span?.attributes["web_ai.tool.call_names"]).toEqual([
        "get_weather",
      ]);
      expect(span?.attributes["gen_ai.response.finish_reasons"]).toEqual([
        "tool_call",
      ]);

      const output = String(span?.attributes["gen_ai.output.messages"]);
      expect(output).toContain("tool_call");
      expect(output).toContain("Tokyo");
      // The fields live on the prototype, so a naive encode would emit `{}`.
      expect(output).not.toContain("{}");
    });

    it("times the tool run and keeps the exchange in one trace", async () => {
      mockSession.prompt = vi
        .fn()
        .mockResolvedValueOnce([
          toolCallChunk(toolCall("get_weather", { city: "Nara" })),
        ])
        .mockResolvedValueOnce("It is clear in Nara.");

      const session = await LanguageModel.create({ tools: [WEATHER_TOOL] });
      await session.prompt("weather in Nara?");
      await session.prompt(
        toolResponseTurn(toolSuccess("get_weather", { tempC: 24 }))
      );

      const [first, second] = turnSpans();
      const [toolSpan] = toolSpans();

      expect(toolSpan?.name).toBe("execute_tool get_weather");
      expect(toolSpan?.attributes["gen_ai.operation.name"]).toBe(
        "execute_tool"
      );
      expect(toolSpan?.attributes["gen_ai.tool.type"]).toBe("function");
      expect(toolSpan?.attributes["gen_ai.tool.description"]).toBe(
        WEATHER_TOOL.description
      );
      expect(toolSpan?.attributes["web_ai.tool.call_index"]).toBe(1);
      expect(String(toolSpan?.attributes["web_ai.tool.result"])).toContain(
        "24"
      );

      // One question and its tool round form one trace, rooted on the exchange
      // rather than on the first turn.
      const root = spanNamed("invoke_agent");
      const rootId = root?.spanContext().spanId;
      expect(root?.parentSpanContext).toBeUndefined();
      for (const span of [first, second, toolSpan]) {
        expect(span?.spanContext().traceId).toBe(root?.spanContext().traceId);
        expect(span?.parentSpanContext?.spanId).toBe(rootId);
      }

      expect(second?.attributes["web_ai.conversation.turn_continuation"]).toBe(
        true
      );
      expect(second?.attributes["web_ai.tool.response_count"]).toBe(1);
    });

    it("answers the exchange on its root span", async () => {
      mockSession.prompt = vi
        .fn()
        .mockResolvedValueOnce([
          toolCallChunk(toolCall("get_weather", { city: "Kyoto" })),
        ])
        .mockResolvedValueOnce("It is raining in Kyoto.");

      const session = await LanguageModel.create({ tools: [WEATHER_TOOL] });
      await session.prompt("weather in Kyoto?");
      await session.prompt(
        toolResponseTurn(toolSuccess("get_weather", { tempC: 22 }))
      );

      const root = spanNamed("invoke_agent");
      expect(root?.attributes["gen_ai.operation.name"]).toBe("invoke_agent");
      expect(root?.attributes["web_ai.exchange.turn_count"]).toBe(2);
      expect(root?.attributes["web_ai.exchange.tool_call_count"]).toBe(1);
      expect(root?.attributes["gen_ai.response.finish_reasons"]).toEqual([
        "stop",
      ]);
      expect(root?.attributes["web_ai.exchange.abandoned"]).toBeUndefined();

      // The question and the answer, not the tool call in between.
      expect(String(root?.attributes["gen_ai.input.messages"])).toContain(
        "weather in Kyoto?"
      );
      expect(String(root?.attributes["gen_ai.output.messages"])).toContain(
        "It is raining in Kyoto."
      );
    });

    it("keeps the exchange around everything it holds", async () => {
      mockSession.prompt = vi
        .fn()
        .mockResolvedValueOnce([
          toolCallChunk(toolCall("get_weather", { city: "Kobe" })),
        ])
        .mockResolvedValueOnce("It is windy in Kobe.");

      const session = await LanguageModel.create({ tools: [WEATHER_TOOL] });
      await session.prompt("weather in Kobe?");
      await session.prompt(
        toolResponseTurn(toolSuccess("get_weather", { tempC: 19 }))
      );

      const root = spanNamed("invoke_agent");
      const children = exporter
        .getFinishedSpans()
        .filter(
          (span) =>
            span.parentSpanContext?.spanId === root?.spanContext().spanId
        );

      expect(children).toHaveLength(3);
      // Turns and tool runs happen one after another, so they are siblings in
      // the order they ran, each inside the window of the exchange.
      let previous = startedAt(root);
      for (const child of children) {
        expect(startedAt(child)).toBeGreaterThanOrEqual(previous);
        expect(endedAt(child)).toBeLessThanOrEqual(endedAt(root));
        previous = startedAt(child);
      }
      expect(children.map((child) => child.name)).toEqual([
        "generate_content",
        "execute_tool get_weather",
        "generate_content",
      ]);
    });

    it("marks an exchange the page never came back to", async () => {
      mockSession.prompt = vi.fn(() =>
        Promise.resolve([
          toolCallChunk(toolCall("get_weather", { city: "Ise" })),
        ])
      );

      const session = await LanguageModel.create({ tools: [WEATHER_TOOL] });
      await session.prompt("weather in Ise?");
      // No tool responses ever arrive; the page just drops the session.
      session.destroy();

      const root = spanNamed("invoke_agent");
      expect(root?.attributes["web_ai.exchange.abandoned"]).toBe(true);
      expect(
        root?.attributes["gen_ai.response.finish_reasons"]
      ).toBeUndefined();
    });

    it("leaves a session without tools as a single span", async () => {
      const session = await LanguageModel.create();
      await session.prompt("hello");

      expect(spanNamed("invoke_agent")).toBeUndefined();
      expect(turnSpans()[0]?.parentSpanContext).toBeUndefined();
    });

    it("does not charge a tool for the generation that followed its call", async () => {
      // The model asks for the tool early, then keeps generating. The page
      // cannot run anything until the stream closes, so that tail belongs to
      // generate_content, not to the tool.
      const generationTailMs = 60;
      mockSession.promptStreaming = vi.fn(() =>
        slowStream(
          [toolCallChunk(toolCall("get_weather", { city: "Osaka" }))],
          generationTailMs,
          ["thinking about it"]
        )
      );

      const session = await LanguageModel.create({ tools: [WEATHER_TOOL] });
      await drain(session.promptStreaming("weather in Osaka?"));
      await session.prompt(
        toolResponseTurn(toolSuccess("get_weather", { tempC: 24 }))
      );

      const [turn] = turnSpans();
      const [toolSpan] = toolSpans();

      expect(durationMs(turn)).toBeGreaterThanOrEqual(generationTailMs);
      expect(durationMs(toolSpan)).toBeLessThan(generationTailMs);
    });

    it("starts a new trace for a question that carries no tool responses", async () => {
      const session = await LanguageModel.create();
      await session.prompt("one");
      await session.prompt("two");

      const [first, second] = turnSpans();
      expect(second?.spanContext().traceId).not.toBe(
        first?.spanContext().traceId
      );
      expect(
        second?.attributes["web_ai.conversation.turn_continuation"]
      ).toBeUndefined();
    });

    it("forwards tool-call chunks untouched while streaming", async () => {
      const call = toolCall("get_weather", { city: "Kyoto" });
      mockSession.promptStreaming = vi.fn(() =>
        streamOf(["Checking… ", toolCallChunk(call)])
      );
      const session = await LanguageModel.create({ tools: [WEATHER_TOOL] });
      const chunks = await collect(session.promptStreaming("weather?"));

      // The page runs the tool loop, so it needs the original object.
      expect(chunks[0]).toBe("Checking… ");
      expect((chunks[1] as LanguageModelToolCallContent).value).toBe(call);

      const span = spanNamed("generate_content");
      expect(span?.attributes["web_ai.stream.chunk_count"]).toBe(2);
      expect(span?.attributes["web_ai.tool.call_count"]).toBe(1);

      const output = String(span?.attributes["gen_ai.output.messages"]);
      expect(output).toContain("Checking… ");
      // A tool call concatenated as text would land here as "[object Object]".
      expect(output).not.toContain("[object Object]");
    });

    it("pairs parallel calls with their responses by name", async () => {
      mockSession.prompt = vi
        .fn()
        .mockResolvedValueOnce([
          toolCallChunk(toolCall("get_weather", { city: "Kyoto" })),
          toolCallChunk(toolCall("get_population", { city: "Kyoto" })),
        ])
        .mockResolvedValueOnce("Kyoto is clear, with 1.4M people.");

      const session = await LanguageModel.create({ tools: [WEATHER_TOOL] });
      await session.prompt("weather and population of Kyoto?");
      await session.prompt(
        toolResponseTurn(
          toolSuccess("get_population", { people: 1_400_000 }),
          toolSuccess("get_weather", { tempC: 22 })
        )
      );

      const spans = toolSpans();
      expect(spans).toHaveLength(2);
      // Both callIDs are empty and the answers came back in the opposite order,
      // so only the name can pair them up.
      expect(spans.map((span) => span.attributes["gen_ai.tool.name"])).toEqual([
        "get_population",
        "get_weather",
      ]);
      expect(
        spans.map((span) => span.attributes["web_ai.tool.call_index"])
      ).toEqual([2, 1]);
    });

    it("marks a failed tool with an error status", async () => {
      mockSession.prompt = vi
        .fn()
        .mockResolvedValueOnce([toolCallChunk(toolCall("get_weather", {}))])
        .mockResolvedValueOnce("I could not look that up.");

      const session = await LanguageModel.create({ tools: [WEATHER_TOOL] });
      await session.prompt("weather?");
      await session.prompt(
        toolResponseTurn(toolError("get_weather", 'missing "city"'))
      );

      const [toolSpan] = toolSpans();
      expect(toolSpan?.status.code).toBe(SPAN_STATUS_ERROR);
      expect(toolSpan?.status.message).toBe('missing "city"');
      expect(toolSpan?.attributes["web_ai.tool.failed"]).toBe(true);
      expect(toolSpan?.attributes["error.type"]).toBe("ToolError");
    });

    it("keeps tool payloads out of spans when capture is off", async () => {
      instrumentation.disable();
      exporter.reset();
      setup({ captureInput: false, captureOutput: false });

      mockSession.prompt = vi
        .fn()
        .mockResolvedValueOnce([
          toolCallChunk(toolCall("get_weather", { city: "Osaka" })),
        ])
        .mockResolvedValueOnce("done");

      const session = await LanguageModel.create({ tools: [WEATHER_TOOL] });
      await session.prompt("weather?");
      await session.prompt(
        toolResponseTurn(toolSuccess("get_weather", { tempC: 31 }))
      );

      const turn = spanNamed("generate_content");
      const [toolSpan] = toolSpans();

      // The shape of the exchange stays visible; the payloads do not.
      expect(turn?.attributes["web_ai.tool.call_names"]).toEqual([
        "get_weather",
      ]);
      expect(turn?.attributes["gen_ai.output.messages"]).toBeUndefined();
      expect(toolSpan?.attributes["gen_ai.tool.name"]).toBe("get_weather");
      expect(
        toolSpan?.attributes["web_ai.tool.call_arguments"]
      ).toBeUndefined();
      expect(toolSpan?.attributes["web_ai.tool.result"]).toBeUndefined();
      expect(
        spanNamed("web_ai.create_session")?.attributes[
          "gen_ai.tool.definitions"
        ]
      ).toBeUndefined();
    });

    it("groups tool spans into the conversation", async () => {
      mockSession.prompt = vi
        .fn()
        .mockResolvedValueOnce([
          toolCallChunk(toolCall("get_weather", { city: "Kobe" })),
        ])
        .mockResolvedValueOnce("Clear in Kobe.");

      const session = await LanguageModel.create({ tools: [WEATHER_TOOL] });
      await session.prompt("weather in Kobe?");
      await session.prompt(
        toolResponseTurn(toolSuccess("get_weather", { tempC: 26 }))
      );

      const [toolSpan] = toolSpans();
      const [turn] = turnSpans();
      // Needed by the sessions view, which groups on the conversation id.
      expect(toolSpan?.attributes["gen_ai.conversation.id"]).toBe(
        turn?.attributes["gen_ai.conversation.id"]
      );
      expect(toolSpan?.attributes["web_ai.api.name"]).toBe("LanguageModel");
    });
  });
});
