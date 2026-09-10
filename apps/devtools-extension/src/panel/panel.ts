import {
  type PanelRequest,
  type PanelResponses,
  TRACES_UPDATED,
} from "../shared/messages.js";
import type {
  SessionSummary,
  StoredSpan,
  TraceSummary,
} from "../storage/indexed-db.js";
import {
  el,
  formatDuration,
  formatTime,
  metaList,
  plural,
  shortId,
  toolSuffix,
} from "./panel-utils.js";
import { buildSpanExplorer } from "./span-explorer.js";

const REFRESH_DEBOUNCE_MS = 250;
const SPAN_STATUS_ERROR = 2;

type View = "traces" | "sessions";

const inspectedTabId = chrome.devtools.inspectedWindow.tabId;

let view: View = "traces";
let selectedId: string | null = null;
let refreshTimer: number | undefined;

async function request<T extends PanelRequest["type"]>(
  message: Extract<PanelRequest, { type: T }>
): Promise<PanelResponses[T]> {
  const response = (await chrome.runtime.sendMessage(message)) as
    | PanelResponses[T]
    | { error: string };
  if (response && "error" in response) {
    throw new Error(response.error);
  }
  return response;
}

function detailEl(): HTMLElement | null {
  return document.getElementById("trace-detail");
}

async function showTraceDetail(trace: TraceSummary): Promise<void> {
  const target = detailEl();
  if (!target) {
    return;
  }

  const { spans } = await request({
    type: "get-trace-spans",
    traceId: trace.traceId,
  });

  const heading = document.createElement("h2");
  heading.textContent = trace.rootSpanName;

  target.replaceChildren(
    heading,
    metaList([
      ["Trace", shortId(trace.traceId)],
      ["Session", trace.conversationId && shortId(trace.conversationId)],
      ["Origin", trace.origin],
      ["Spans", String(trace.spanCount)],
      [
        "Tool calls",
        trace.toolCallCount > 0 ? String(trace.toolCallCount) : undefined,
      ],
      ["Duration", formatDuration(trace.durationMs)],
      ["URL", trace.url],
    ]),
    buildSpanExplorer(spans ?? [])
  );
}

/**
 * A session view groups every trace sharing a conversation id. A question
 * answered without tools is a trace of its own, while a tool exchange is one
 * trace holding several turns, so spans are grouped by trace here rather than
 * rendered as a single tree. Each group gets its own span explorer, so the
 * selection in one trace never affects another.
 */
async function showSessionDetail(session: SessionSummary): Promise<void> {
  const target = detailEl();
  if (!target) {
    return;
  }

  const { spans } = await request({
    type: "get-session-spans",
    conversationId: session.conversationId,
  });

  const heading = document.createElement("h2");
  heading.textContent = `Session ${shortId(session.conversationId)}`;

  const context =
    session.contextUsage !== undefined && session.contextWindow !== undefined
      ? `${session.contextUsage} / ${session.contextWindow} tokens`
      : undefined;

  const nodes: Node[] = [
    heading,
    metaList([
      ["Origin", session.origin],
      ["Turns", String(session.turnCount)],
      ["Traces", String(session.traceIds.length)],
      ["Spans", String(session.spanCount)],
      [
        "Tool calls",
        session.toolCallCount > 0 ? String(session.toolCallCount) : undefined,
      ],
      ["Errors", session.errorCount ? String(session.errorCount) : undefined],
      ["Duration", formatDuration(session.durationMs)],
      ["Context", context],
      ["URL", session.url],
    ]),
  ];

  const byTrace = new Map<string, StoredSpan[]>();
  for (const span of spans ?? []) {
    const list = byTrace.get(span.traceId) ?? [];
    list.push(span);
    byTrace.set(span.traceId, list);
  }

  for (const [traceId, traceSpans] of byTrace) {
    const group = el("section", "trace-group");
    const title = document.createElement("h3");
    title.textContent = `${traceSpans[0]?.name ?? "trace"} · ${shortId(traceId)}`;
    group.append(title, buildSpanExplorer(traceSpans));
    nodes.push(group);
  }

  target.replaceChildren(...nodes);
}

function listItem(
  id: string,
  hasError: boolean,
  rows: Array<HTMLElement | undefined>,
  onSelect: () => void
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = hasError ? "trace-item has-error" : "trace-item";
  btn.dataset.entryId = id;
  btn.append(...rows.filter((row): row is HTMLElement => row !== undefined));
  btn.addEventListener("click", () => {
    selectedId = id;
    markSelected();
    onSelect();
  });
  return btn;
}

function markSelected(): void {
  const listEl = document.getElementById("trace-list");
  for (const node of listEl?.querySelectorAll(".trace-item") ?? []) {
    node.classList.toggle(
      "active",
      (node as HTMLElement).dataset.entryId === selectedId
    );
  }
}

function traceRow(trace: TraceSummary): HTMLButtonElement {
  return listItem(
    trace.traceId,
    trace.statusCode === SPAN_STATUS_ERROR,
    [
      el("div", "name", trace.rootSpanName),
      trace.request ? el("div", "preview", trace.request) : undefined,
      trace.response
        ? el("div", "preview response", trace.response)
        : undefined,
      el("div", "meta", trace.origin),
      el(
        "div",
        "meta",
        `${formatTime(trace.startTimeMs)} · ${formatDuration(trace.durationMs)} · ${plural(trace.spanCount, "span")}${toolSuffix(trace.toolCallCount)}`
      ),
    ],
    () => {
      showTraceDetail(trace).catch(console.error);
    }
  );
}

function sessionRow(session: SessionSummary): HTMLButtonElement {
  const turns = plural(session.turnCount, "turn");
  return listItem(
    session.conversationId,
    session.errorCount > 0,
    [
      el("div", "name", `Session ${shortId(session.conversationId)}`),
      session.request ? el("div", "preview", session.request) : undefined,
      session.response
        ? el("div", "preview response", session.response)
        : undefined,
      el("div", "meta", session.origin),
      el(
        "div",
        "meta",
        `${formatTime(session.startTimeMs)} · ${formatDuration(session.durationMs)} · ${turns}${toolSuffix(session.toolCallCount)}`
      ),
    ],
    () => {
      showSessionDetail(session).catch(console.error);
    }
  );
}

const EMPTY_DETAIL = "Use a Web AI API on this page to record telemetry.";

/** Detail always belongs to a selection, so it resets whenever one is lost. */
function clearDetail(): void {
  selectedId = null;
  detailEl()?.replaceChildren(el("p", "empty", EMPTY_DETAIL));
}

async function loadTraces(listEl: HTMLElement): Promise<void> {
  const { traces } = await request({
    type: "list-traces",
    tabId: inspectedTabId,
  });
  if (!traces?.length) {
    listEl.replaceChildren(el("p", "empty", "No traces yet."));
    clearDetail();
    return;
  }

  listEl.replaceChildren(...traces.map(traceRow));
  const selected = traces.find((t) => t.traceId === selectedId);
  if (selected) {
    markSelected();
    await showTraceDetail(selected);
  } else {
    clearDetail();
  }
}

async function loadSessions(listEl: HTMLElement): Promise<void> {
  const { sessions } = await request({
    type: "list-sessions",
    tabId: inspectedTabId,
  });
  if (!sessions?.length) {
    listEl.replaceChildren(el("p", "empty", "No sessions yet."));
    clearDetail();
    return;
  }

  listEl.replaceChildren(...sessions.map(sessionRow));
  const selected = sessions.find((s) => s.conversationId === selectedId);
  if (selected) {
    markSelected();
    await showSessionDetail(selected);
  } else {
    clearDetail();
  }
}

async function load(): Promise<void> {
  const listEl = document.getElementById("trace-list");
  if (!listEl) {
    return;
  }
  if (view === "sessions") {
    await loadSessions(listEl);
  } else {
    await loadTraces(listEl);
  }
}

function setView(next: View): void {
  if (view === next) {
    return;
  }
  view = next;
  clearDetail();
  for (const id of ["traces", "sessions"] as const) {
    document
      .getElementById(`view-${id}`)
      ?.setAttribute("aria-selected", String(id === next));
  }
  load().catch(console.error);
}

function scheduleRefresh(): void {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    load().catch(console.error);
  }, REFRESH_DEBOUNCE_MS) as unknown as number;
}

/** Makes the tab scoping visible, since the panel never shows other tabs. */
function showScope(): void {
  chrome.devtools.inspectedWindow.eval(
    "location.origin",
    (result: unknown, error) => {
      const scope = document.getElementById("scope");
      if (!scope) {
        return;
      }
      scope.textContent = error
        ? `Inspected tab ${inspectedTabId}`
        : `Inspected tab ${inspectedTabId} · ${String(result)}`;
    }
  );
}

document.getElementById("view-traces")?.addEventListener("click", () => {
  setView("traces");
});

document.getElementById("view-sessions")?.addEventListener("click", () => {
  setView("sessions");
});

document.getElementById("refresh")?.addEventListener("click", () => {
  load().catch(console.error);
});

document.getElementById("clear")?.addEventListener("click", () => {
  (async () => {
    await request({ type: "clear-traces", tabId: inspectedTabId });
    clearDetail();
    await load();
  })().catch(console.error);
});

document.getElementById("export")?.addEventListener("click", () => {
  (async () => {
    const { spans } = await request({
      type: "export-traces",
      tabId: inspectedTabId,
    });
    const blob = new Blob([JSON.stringify(spans ?? [], null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `web-ai-traces-${Date.now()}.json`;
    a.click();
    // Revoking in the same task can cancel the download before it starts.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  })().catch(console.error);
});

chrome.runtime.onMessage.addListener((message) => {
  const msg = message as { type?: string; tabId?: number };
  if (msg?.type !== TRACES_UPDATED) {
    return;
  }
  if (msg.tabId !== undefined && msg.tabId !== inspectedTabId) {
    return;
  }
  scheduleRefresh();
});

showScope();
load().catch(console.error);
