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
    attributes: attrs,
    endTime: span.endTime,
    events: span.events.map((event) => ({
      attributes: event.attributes ? { ...event.attributes } : undefined,
      name: event.name,
      time: event.time,
    })),
    frame: {
      origin: globalThis.location?.origin,
      url: globalThis.location?.href,
    },
    kind: span.kind,
    name: span.name,
    parentSpanId: span.parentSpanContext?.spanId,
    protocolVersion: PROTOCOL_VERSION,
    spanId: span.spanContext().spanId,
    startTime: span.startTime,
    status: {
      code: span.status.code,
      message: span.status.message,
    },
    traceId: span.spanContext().traceId,
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
          payload,
          source: MESSAGE_SOURCE,
          type: SPAN_MESSAGE_TYPE,
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
