import { describe, expect, it } from "vitest";
import {
  isSpanMessage,
  MESSAGE_SOURCE,
  PROTOCOL_VERSION,
  type SerializedSpan,
  SPAN_MESSAGE_TYPE,
  validateSerializedSpan,
} from "../src/protocol.js";

function validSpan(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    name: "generate_content",
    kind: 0,
    startTime: [1_700_000_000, 0],
    endTime: [1_700_000_001, 0],
    attributes: { "gen_ai.provider.name": "google.chrome" },
    events: [],
    status: { code: 1 },
    ...overrides,
  };
}

describe("isSpanMessage", () => {
  it("accepts a well-formed envelope", () => {
    expect(
      isSpanMessage({
        source: MESSAGE_SOURCE,
        type: SPAN_MESSAGE_TYPE,
        payload: validSpan(),
      })
    ).toBe(true);
  });

  it.each([
    ["null", null],
    ["a primitive", "web-ai-otel"],
    [
      "a foreign source",
      { source: "other", type: SPAN_MESSAGE_TYPE, payload: {} },
    ],
    ["a foreign type", { source: MESSAGE_SOURCE, type: "other", payload: {} }],
    ["a missing payload", { source: MESSAGE_SOURCE, type: SPAN_MESSAGE_TYPE }],
  ])("rejects %s", (_label, input) => {
    expect(isSpanMessage(input)).toBe(false);
  });
});

describe("validateSerializedSpan", () => {
  it("accepts a well-formed span", () => {
    const span = validateSerializedSpan(validSpan());
    expect(span).not.toBeNull();
    expect(span?.name).toBe("generate_content");
  });

  it.each([
    ["a non-object", 42],
    ["a mismatched protocol version", validSpan({ protocolVersion: 999 })],
    ["a short trace id", validSpan({ traceId: "abcd" })],
    ["a non-hex trace id", validSpan({ traceId: "z".repeat(32) })],
    ["a short span id", validSpan({ spanId: "abcd" })],
    ["a malformed parent span id", validSpan({ parentSpanId: "nope" })],
    ["a non-string name", validSpan({ name: { toString: "evil" } })],
    ["a missing kind", validSpan({ kind: "internal" })],
    ["a malformed start time", validSpan({ startTime: [1] })],
    ["a non-finite time", validSpan({ endTime: [Number.NaN, 0] })],
    ["array attributes", validSpan({ attributes: [] })],
    ["non-array events", validSpan({ events: {} })],
    ["an event without a time", validSpan({ events: [{ name: "e" }] })],
    ["a missing status code", validSpan({ status: {} })],
  ])("rejects %s", (_label, input) => {
    expect(validateSerializedSpan(input)).toBeNull();
  });

  it("strips unknown top-level fields", () => {
    const span = validateSerializedSpan(
      validSpan({ __proto__hack: "x", extra: "y" })
    ) as SerializedSpan & Record<string, unknown>;
    expect(span.extra).toBeUndefined();
    expect(span.__proto__hack).toBeUndefined();
  });

  it("keeps only string url and origin on frame", () => {
    const span = validateSerializedSpan(
      validSpan({ frame: { url: "https://example.com/a", origin: 42 } })
    );
    expect(span?.frame?.url).toBe("https://example.com/a");
    expect(span?.frame?.origin).toBeUndefined();
  });

  it("normalizes a non-object frame to undefined", () => {
    expect(
      validateSerializedSpan(validSpan({ frame: "nope" }))?.frame
    ).toBeUndefined();
  });

  it("preserves valid events with attributes", () => {
    const span = validateSerializedSpan(
      validSpan({
        events: [
          {
            name: "web_ai.context_overflow",
            time: [1_700_000_000, 5],
            attributes: { "web_ai.context.overflowed": true },
          },
        ],
      })
    );
    expect(span?.events).toHaveLength(1);
    expect(span?.events[0]?.attributes).toEqual({
      "web_ai.context.overflowed": true,
    });
  });
});
