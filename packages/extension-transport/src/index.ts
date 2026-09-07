import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  MESSAGE_SOURCE,
  PROTOCOL_VERSION,
  type SerializedSpan,
  SPAN_MESSAGE_TYPE,
  type SpanMessage,
} from "./protocol.js";

function serializeSpan(span: ReadableSpan): SerializedSpan {
  const attrs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(span.attributes)) {
    attrs[key] = value;
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    parentSpanId: span.parentSpanContext?.spanId,
    name: span.name,
    kind: span.kind,
    startTime: span.startTime,
    endTime: span.endTime,
    attributes: attrs,
    events: span.events.map((event) => ({
      name: event.name,
      time: event.time,
      attributes: event.attributes ? { ...event.attributes } : undefined,
    })),
    status: {
      code: span.status.code,
      message: span.status.message,
    },
    frame: {
      url: globalThis.location?.href,
      origin: globalThis.location?.origin,
    },
  };
}

export interface ExtensionSpanExporterOptions {
  postMessage?: (message: SpanMessage) => void;
}

/** SpanExporter that posts serialized spans to the extension bridge via postMessage. */
export class ExtensionSpanExporter implements SpanExporter {
  private readonly postMessage: (message: SpanMessage) => void;

  constructor(options: ExtensionSpanExporterOptions = {}) {
    this.postMessage =
      options.postMessage ??
      ((message) => {
        globalThis.postMessage(message, "*");
      });
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void
  ): void {
    try {
      for (const span of spans) {
        const payload = serializeSpan(span);
        this.postMessage({
          source: MESSAGE_SOURCE,
          type: SPAN_MESSAGE_TYPE,
          payload,
        });
      }
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (err) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export type {
  SerializedSpan,
  SpanMessage,
  SpanSource,
} from "./protocol.js";
export {
  isSpanMessage,
  MESSAGE_SOURCE,
  PROTOCOL_VERSION,
  SPAN_MESSAGE_TYPE,
  validateSerializedSpan,
} from "./protocol.js";
