import type { TracerProvider } from "@opentelemetry/api";
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

function streamOf(chunks: string[]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

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
    prompt: vi.fn((input: string) => Promise.resolve(`reply:${input}`)),
    promptStreaming: vi.fn((input: string) => streamOf(["stream:", input])),
    destroy: vi.fn(),
    clone: vi.fn(() => Promise.resolve(createMockSession())),
    ...overrides,
  };
  return session;
}

async function drain(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  let chunk = await reader.read();
  while (!chunk.done) {
    text += chunk.value;
    chunk = await reader.read();
  }
  return text;
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
});
