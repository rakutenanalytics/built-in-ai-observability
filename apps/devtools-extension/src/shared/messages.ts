import type { SerializedSpan } from "@web-ai-otel/extension-transport/protocol";
import type {
  SessionSummary,
  StoredSpan,
  TraceSummary,
} from "../storage/indexed-db.js";

/** Content-script bridge -> background. */
export const BRIDGE_SPAN = "web-ai-otel:bridge-span";
/** Background -> DevTools panel. */
export const TRACES_UPDATED = "web-ai-otel:traces-updated";

export interface BridgeSpanMessage {
  type: typeof BRIDGE_SPAN;
  payload: SerializedSpan;
}

export interface TracesUpdatedMessage {
  type: typeof TRACES_UPDATED;
  tabId?: number;
}

export type PanelRequest =
  | { type: "list-traces"; tabId?: number }
  | { type: "list-sessions"; tabId?: number }
  | { type: "get-trace-spans"; traceId: string }
  | { type: "get-session-spans"; conversationId: string }
  | { type: "clear-traces"; tabId?: number }
  | { type: "export-traces"; tabId?: number };

export interface PanelResponses {
  "list-traces": { traces: TraceSummary[] };
  "list-sessions": { sessions: SessionSummary[] };
  "get-trace-spans": { spans: StoredSpan[] };
  "get-session-spans": { spans: StoredSpan[] };
  "clear-traces": { ok: true };
  "export-traces": { spans: StoredSpan[] };
}

export type PanelResponse<T extends PanelRequest["type"]> =
  | PanelResponses[T]
  | { error: string };
