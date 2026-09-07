import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExtensionSpanExporter } from "../src/index.js";
import {
  isSpanMessage,
  PROTOCOL_VERSION,
  type SpanMessage,
  validateSerializedSpan,
} from "../src/protocol.js";

const TRACE_ID_HEX = /^[0-9a-f]{32}$/;
const SPAN_ID_HEX = /^[0-9a-f]{16}$/;

/**
 * Guards the seam between the OpenTelemetry SDK and the extension wire format:
 * real spans must serialize into payloads the bridge validator accepts.
 */
describe("ExtensionSpanExporter", () => {
  let messages: SpanMessage[];
  let provider: BasicTracerProvider;

  beforeEach(() => {
    messages = [];
    provider = new BasicTracerProvider({
      spanProcessors: [
        new SimpleSpanProcessor(
          new ExtensionSpanExporter({
            postMessage: (message) => messages.push(message),
          })
        ),
      ],
    });
  });

  afterEach(async () => {
    await provider.shutdown();
  });

  it("emits one validated message per finished span", () => {
    const tracer = provider.getTracer("test");
    const span = tracer.startSpan("generate_content", {
      kind: SpanKind.INTERNAL,
      attributes: { "gen_ai.provider.name": "google.chrome" },
    });
    span.addEvent("web_ai.context_overflow", { "web_ai.context.usage": 10 });
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();

    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(isSpanMessage(message)).toBe(true);

    // The payload must survive the validator the bridge applies.
    const validated = validateSerializedSpan(message.payload);
    expect(validated).not.toBeNull();
    expect(validated?.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(validated?.name).toBe("generate_content");
    expect(validated?.attributes["gen_ai.provider.name"]).toBe("google.chrome");
    expect(validated?.events[0]?.name).toBe("web_ai.context_overflow");
    expect(validated?.status.code).toBe(SpanStatusCode.OK);
  });

  it("preserves the parent relationship for child spans", () => {
    const tracer = provider.getTracer("test");
    const parent = tracer.startSpan("web_ai.create_session");
    const child = tracer.startSpan(
      "generate_content",
      undefined,
      trace.setSpan(ROOT_CONTEXT, parent)
    );
    child.end();
    parent.end();

    const [childMessage, parentMessage] = messages;
    expect(childMessage.payload.parentSpanId).toBe(parent.spanContext().spanId);
    expect(childMessage.payload.traceId).toBe(parent.spanContext().traceId);
    expect(parentMessage.payload.parentSpanId).toBeUndefined();

    // Parent ids must also pass validation, not just be present.
    expect(validateSerializedSpan(childMessage.payload)).not.toBeNull();
  });

  it("reports trace and span ids as valid hex identifiers", () => {
    const span = provider.getTracer("test").startSpan("web_ai.create_session");
    span.end();

    const { traceId, spanId } = messages[0].payload;
    expect(traceId).toMatch(TRACE_ID_HEX);
    expect(spanId).toMatch(SPAN_ID_HEX);
  });

  it("defaults to posting on the global scope", () => {
    const posted: unknown[] = [];
    const original = globalThis.postMessage;
    globalThis.postMessage = ((message: unknown) => {
      posted.push(message);
    }) as typeof globalThis.postMessage;

    try {
      const exporter = new ExtensionSpanExporter();
      const local = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      const span = local.getTracer("test").startSpan("web_ai.create_session");
      span.end();
      expect(posted).toHaveLength(1);
    } finally {
      globalThis.postMessage = original;
    }
  });
});
