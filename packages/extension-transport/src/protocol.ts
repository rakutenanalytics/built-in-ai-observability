export const PROTOCOL_VERSION = 1;
export const MESSAGE_SOURCE = "web-ai-otel";
export const SPAN_MESSAGE_TYPE = "web-ai-otel:span";

const TRACE_ID_LENGTH = 32;
const SPAN_ID_LENGTH = 16;
const HR_TIME_PARTS = 2;
const HEX_ID = /^[0-9a-f]+$/;

/** A span as reported by the instrumented page. Everything here is untrusted. */
export interface SerializedSpan {
  protocolVersion: number;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTime: [number, number];
  endTime: [number, number];
  attributes: Record<string, unknown>;
  events: Array<{
    name: string;
    time: [number, number];
    attributes?: Record<string, unknown>;
  }>;
  status: { code: number; message?: string };
  /** Self-reported by the page; prefer `SpanSource` for attribution. */
  frame?: {
    url?: string;
    origin?: string;
  };
}

/**
 * Attribution the extension derives from the message sender rather than the
 * page, so it cannot be spoofed by page scripts.
 */
export interface SpanSource {
  tabId?: number;
  frameId?: number;
  url?: string;
  origin?: string;
}

export interface SpanMessage {
  source: typeof MESSAGE_SOURCE;
  type: typeof SPAN_MESSAGE_TYPE;
  payload: SerializedSpan;
}

export function isSpanMessage(data: unknown): data is SpanMessage {
  if (!data || typeof data !== "object") {
    return false;
  }
  const msg = data as Record<string, unknown>;
  return (
    msg.source === MESSAGE_SOURCE &&
    msg.type === SPAN_MESSAGE_TYPE &&
    typeof msg.payload === "object" &&
    msg.payload !== null
  );
}

function isHexId(value: unknown, length: number): value is string {
  return (
    typeof value === "string" && value.length === length && HEX_ID.test(value)
  );
}

function isHrTime(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === HR_TIME_PARTS &&
    value.every((part) => typeof part === "number" && Number.isFinite(part))
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateEvents(value: unknown): SerializedSpan["events"] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const events: SerializedSpan["events"] = [];
  for (const raw of value) {
    if (!isPlainRecord(raw) || typeof raw.name !== "string") {
      return null;
    }
    if (!isHrTime(raw.time)) {
      return null;
    }
    events.push({
      name: raw.name,
      time: raw.time,
      attributes: isPlainRecord(raw.attributes) ? raw.attributes : undefined,
    });
  }
  return events;
}

type Unknowns = Record<string, unknown>;

interface SpanIds {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

interface SpanBody {
  name: string;
  kind: number;
  startTime: [number, number];
  endTime: [number, number];
  attributes: Record<string, unknown>;
  status: Unknowns & { code: number };
}

function hasValidIds(payload: Unknowns): payload is Unknowns & SpanIds {
  return (
    isHexId(payload.traceId, TRACE_ID_LENGTH) &&
    isHexId(payload.spanId, SPAN_ID_LENGTH) &&
    (payload.parentSpanId === undefined ||
      isHexId(payload.parentSpanId, SPAN_ID_LENGTH))
  );
}

function hasValidBody(payload: Unknowns): payload is Unknowns & SpanBody {
  return (
    typeof payload.name === "string" &&
    typeof payload.kind === "number" &&
    isHrTime(payload.startTime) &&
    isHrTime(payload.endTime) &&
    isPlainRecord(payload.attributes) &&
    isPlainRecord(payload.status) &&
    typeof payload.status.code === "number"
  );
}

function normalizeFrame(value: unknown): SerializedSpan["frame"] {
  if (!isPlainRecord(value)) {
    return;
  }
  return {
    url: typeof value.url === "string" ? value.url : undefined,
    origin: typeof value.origin === "string" ? value.origin : undefined,
  };
}

/**
 * Structurally validates an untrusted span payload, returning a normalized copy
 * with unknown fields stripped, or `null` when the payload is malformed.
 */
export function validateSerializedSpan(
  payload: unknown
): SerializedSpan | null {
  if (!isPlainRecord(payload)) {
    return null;
  }
  if (payload.protocolVersion !== PROTOCOL_VERSION) {
    return null;
  }
  if (!(hasValidIds(payload) && hasValidBody(payload))) {
    return null;
  }
  const events = validateEvents(payload.events);
  if (events === null) {
    return null;
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    traceId: payload.traceId,
    spanId: payload.spanId,
    parentSpanId: payload.parentSpanId,
    name: payload.name,
    kind: payload.kind,
    startTime: payload.startTime,
    endTime: payload.endTime,
    attributes: payload.attributes,
    events,
    status: {
      code: payload.status.code,
      message:
        typeof payload.status.message === "string"
          ? payload.status.message
          : undefined,
    },
    frame: normalizeFrame(payload.frame),
  };
}
