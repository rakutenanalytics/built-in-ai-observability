export const PROTOCOL_VERSION = 1;
export const MESSAGE_SOURCE = "web-ai-otel";
export const SPAN_MESSAGE_TYPE = "web-ai-otel:span";

const TRACE_ID_LENGTH = 32;
const SPAN_ID_LENGTH = 16;
const HR_TIME_PARTS = 2;
const HEX_ID = /^[0-9a-f]+$/;

/** A span as reported by the instrumented page. Everything here is untrusted. */
export interface SerializedSpan {
  attributes: Record<string, unknown>;
  endTime: [number, number];
  events: Array<{
    name: string;
    time: [number, number];
    attributes?: Record<string, unknown>;
  }>;
  /** Self-reported by the page; prefer `SpanSource` for attribution. */
  frame?: {
    url?: string;
    origin?: string;
  };
  kind: number;
  name: string;
  parentSpanId?: string;
  protocolVersion: number;
  spanId: string;
  startTime: [number, number];
  status: { code: number; message?: string };
  traceId: string;
}

/**
 * Attribution the extension derives from the message sender rather than the
 * page, so it cannot be spoofed by page scripts.
 */
export interface SpanSource {
  frameId?: number;
  origin?: string;
  tabId?: number;
  url?: string;
}

export interface SpanMessage {
  payload: SerializedSpan;
  source: typeof MESSAGE_SOURCE;
  type: typeof SPAN_MESSAGE_TYPE;
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
      attributes: isPlainRecord(raw.attributes) ? raw.attributes : undefined,
      name: raw.name,
      time: raw.time,
    });
  }
  return events;
}

type Unknowns = Record<string, unknown>;

interface SpanIds {
  parentSpanId?: string;
  spanId: string;
  traceId: string;
}

interface SpanBody {
  attributes: Record<string, unknown>;
  endTime: [number, number];
  kind: number;
  name: string;
  startTime: [number, number];
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
    origin: typeof value.origin === "string" ? value.origin : undefined,
    url: typeof value.url === "string" ? value.url : undefined,
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
    attributes: payload.attributes,
    endTime: payload.endTime,
    events,
    frame: normalizeFrame(payload.frame),
    kind: payload.kind,
    name: payload.name,
    parentSpanId: payload.parentSpanId,
    protocolVersion: PROTOCOL_VERSION,
    spanId: payload.spanId,
    startTime: payload.startTime,
    status: {
      code: payload.status.code,
      message:
        typeof payload.status.message === "string"
          ? payload.status.message
          : undefined,
    },
    traceId: payload.traceId,
  };
}
