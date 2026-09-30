import type { SessionSummary, TraceSummary } from "../storage/indexed-db.js";
import { contextUtilizationLabel } from "./context-meta.js";
import {
  el,
  formatDuration,
  isErrorStatus,
  plural,
  shortId,
  toolSuffix,
} from "./panel-utils.js";
import {
  formatTraceListTime,
  getTimeBucket,
  timeBucketLabel,
} from "./time-format.js";

const COLLAPSED_CHEVRON = "▸";
const EXPANDED_CHEVRON = "▾";

export interface TraceListRender {
  /** Traces in display order, so the drawer can step through them. */
  order: TraceSummary[];
  rows: HTMLElement[];
}

interface TimestampedRow {
  node: HTMLElement;
  timeMs: number;
}

function withTimeBuckets(entries: TimestampedRow[]): HTMLElement[] {
  const rows: HTMLElement[] = [];
  let currentBucket: ReturnType<typeof getTimeBucket> | undefined;

  for (const entry of entries) {
    const bucket = getTimeBucket(entry.timeMs);
    if (bucket !== currentBucket) {
      rows.push(el("div", "time-bucket-header", timeBucketLabel(bucket)));
      currentBucket = bucket;
    }
    rows.push(entry.node);
  }

  return rows;
}

function traceRow(
  trace: TraceSummary,
  onOpen: (trace: TraceSummary) => void
): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = isErrorStatus(trace.statusCode)
    ? "trace-item has-error"
    : "trace-item";
  button.dataset.traceId = trace.traceId;

  const top = el("span", "trace-row-top");
  top.append(
    el("span", "name", trace.rootSpanName),
    el(
      "span",
      "meta",
      `${plural(trace.spanCount, "span")}${toolSuffix(trace.toolCallCount)}`
    ),
    el(
      "span",
      "trace-row-right meta",
      `${formatTraceListTime(trace.startTimeMs)} · ${formatDuration(trace.durationMs)}`
    )
  );
  button.append(top);

  if (trace.request || trace.response) {
    const preview = el("span", "trace-row-preview");
    if (trace.request) {
      preview.append(el("span", "preview", trace.request));
    }
    if (trace.response) {
      preview.append(el("span", "preview response", trace.response));
    }
    button.append(preview);
  }

  button.addEventListener("click", () => onOpen(trace));
  return button;
}

export function renderFlatList(
  traces: TraceSummary[],
  onOpen: (trace: TraceSummary) => void
): TraceListRender {
  const entries = traces.map((trace) => ({
    node: traceRow(trace, onOpen),
    timeMs: trace.startTimeMs,
  }));
  return {
    order: [...traces],
    rows: withTimeBuckets(entries),
  };
}

function sessionMeta(
  session: SessionSummary | undefined,
  traces: TraceSummary[]
): string {
  const parts = [formatTraceListTime(traces[0].startTimeMs)];
  if (session) {
    parts.push(plural(session.turnCount, "turn"));
    parts.push(formatDuration(session.durationMs));
    const context = contextUtilizationLabel(session);
    if (context) {
      parts.push(`${context} context`);
    }
    if (session.errorCount > 0) {
      parts.push(plural(session.errorCount, "error"));
    }
  } else {
    parts.push(plural(traces.length, "trace"));
  }
  return parts.join(" · ");
}

function sessionGroup(
  conversationId: string,
  session: SessionSummary | undefined,
  traces: TraceSummary[],
  onOpen: (trace: TraceSummary) => void,
  expanded: boolean
): HTMLElement {
  const group = el("div", "session-group");
  const header = document.createElement("button");
  header.type = "button";
  header.className = "session-row";
  header.setAttribute("aria-expanded", String(expanded));

  const chevron = el(
    "span",
    "chevron",
    expanded ? EXPANDED_CHEVRON : COLLAPSED_CHEVRON
  );
  header.append(
    chevron,
    el("span", "name", `Session ${shortId(conversationId)}`),
    el("span", "meta", sessionMeta(session, traces))
  );

  const children = el("div", "session-traces");
  children.hidden = !expanded;
  for (const trace of traces) {
    children.append(traceRow(trace, onOpen));
  }

  header.addEventListener("click", () => {
    const open = header.getAttribute("aria-expanded") === "true";
    header.setAttribute("aria-expanded", String(!open));
    chevron.textContent = open ? COLLAPSED_CHEVRON : EXPANDED_CHEVRON;
    children.hidden = open;
  });

  group.append(header, children);
  return group;
}

/**
 * Sessions as expandable groups over the same trace rows, following MLflow's
 * move away from a separate sessions view. Traces recorded outside a session
 * still list on their own, so nothing is hidden by the grouping.
 */
export function renderGroupedList(
  traces: TraceSummary[],
  sessions: SessionSummary[],
  onOpen: (trace: TraceSummary) => void
): TraceListRender {
  const sessionById = new Map(sessions.map((s) => [s.conversationId, s]));
  const grouped = new Map<string, TraceSummary[]>();
  const ungrouped: TraceSummary[] = [];

  for (const trace of traces) {
    if (!trace.conversationId) {
      ungrouped.push(trace);
      continue;
    }
    const list = grouped.get(trace.conversationId) ?? [];
    list.push(trace);
    grouped.set(trace.conversationId, list);
  }

  const entries: TimestampedRow[] = [];
  const order: TraceSummary[] = [];
  // Traces arrive newest first, so the first group is the session being worked
  // on — the only one worth opening expanded.
  let isNewest = true;
  for (const [conversationId, groupTraces] of grouped) {
    entries.push({
      node: sessionGroup(
        conversationId,
        sessionById.get(conversationId),
        groupTraces,
        onOpen,
        isNewest
      ),
      timeMs: groupTraces[0].startTimeMs,
    });
    order.push(...groupTraces);
    isNewest = false;
  }

  for (const trace of ungrouped) {
    entries.push({
      node: traceRow(trace, onOpen),
      timeMs: trace.startTimeMs,
    });
    order.push(trace);
  }

  return { order, rows: withTimeBuckets(entries) };
}
