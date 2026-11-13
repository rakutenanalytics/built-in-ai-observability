import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptApiInstrumentation } from "../src/instrumentation.js";

const CPU_MAX = "web_ai.runtime.pressure.cpu.max";

type Callback = (records: { source: string; state: string }[]) => void;

class FakePressureObserver {
  static constructed = 0;
  static knownSources = ["cpu"];
  static emit: (state: string) => void = () => undefined;

  constructor(callback: Callback) {
    FakePressureObserver.constructed += 1;
    FakePressureObserver.emit = (state) => callback([{ source: "cpu", state }]);
  }

  readonly observe = vi.fn(() => Promise.resolve(undefined));
  readonly disconnect = vi.fn();
}

const mockSession = () => ({
  addEventListener: vi.fn(),
  contextUsage: 10,
  contextWindow: 4096,
  destroy: vi.fn(),
  prompt: vi.fn(() => Promise.resolve("reply")),
});

describe("compute pressure on spans", () => {
  let exporter: InMemorySpanExporter;
  let provider: TracerProvider;
  let instrumentation: PromptApiInstrumentation | undefined;

  const start = (capturePressure: boolean) => {
    instrumentation = new PromptApiInstrumentation({
      capturePressure,
      tracerProvider: provider as unknown as TracerProvider,
    });
    instrumentation.enable();
  };

  const turnSpan = () =>
    exporter
      .getFinishedSpans()
      .find((span) => span.name === "generate_content");

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })],
    });
    FakePressureObserver.constructed = 0;
    (globalThis as Record<string, unknown>).PressureObserver =
      FakePressureObserver;
    (globalThis as Record<string, unknown>).LanguageModel = {
      availability: vi.fn(() => Promise.resolve("available")),
      create: vi.fn(() => Promise.resolve(mockSession())),
    };
  });

  afterEach(async () => {
    instrumentation?.disable();
    instrumentation = undefined;
    (globalThis as Record<string, unknown>).LanguageModel = undefined;
    (globalThis as Record<string, unknown>).PressureObserver = undefined;
    await provider.shutdown();
  });

  it("stamps the worst state seen during a turn when enabled", async () => {
    start(true);
    const session = await LanguageModel.create();
    FakePressureObserver.emit("fair");

    const turn = session.prompt("hello");
    FakePressureObserver.emit("critical");
    FakePressureObserver.emit("nominal");
    await turn;

    expect(turnSpan()?.attributes[CPU_MAX]).toBe("critical");
  });

  it("leaves the attribute off when no reading arrived", async () => {
    start(true);
    const session = await LanguageModel.create();
    await session.prompt("hello");

    expect(turnSpan()?.attributes[CPU_MAX]).toBeUndefined();
  });

  it("does not observe pressure unless asked to", async () => {
    start(false);
    const session = await LanguageModel.create();
    await session.prompt("hello");

    expect(FakePressureObserver.constructed).toBe(0);
    expect(turnSpan()?.attributes[CPU_MAX]).toBeUndefined();
  });
});
