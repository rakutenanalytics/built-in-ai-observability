import {
  type PanelRequest,
  type PanelResponses,
  TRACES_UPDATED,
} from "../shared/messages.js";
import type { StoredSpan, TraceSummary } from "../storage/indexed-db.js";
import { el } from "./panel-utils.js";
import { createTraceDrawer } from "./trace-drawer.js";
import {
  renderFlatList,
  renderGroupedList,
  type TraceListRender,
} from "./trace-list.js";

const REFRESH_DEBOUNCE_MS = 250;
const EMPTY_LIST =
  "No traces yet. Use a Web AI API on this page to record telemetry.";

const inspectedTabId = chrome.devtools.inspectedWindow.tabId;

let groupBySession = false;
/** Display order of the list, which the drawer walks with its arrows. */
let order: TraceSummary[] = [];
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

async function loadSpans(trace: TraceSummary): Promise<StoredSpan[]> {
  const { spans } = await request({
    traceId: trace.traceId,
    type: "get-trace-spans",
  });
  return spans ?? [];
}

const drawer = createTraceDrawer(
  document.getElementById("drawer-host") ?? document.body,
  loadSpans
);

/** Keeps the row you came from marked, so closing the drawer keeps your place. */
function markOpenTrace(): void {
  const openId = drawer.openTraceId();
  for (const node of document.querySelectorAll<HTMLElement>(".trace-item")) {
    node.classList.toggle("active", node.dataset.traceId === openId);
  }
}

function openTrace(trace: TraceSummary): void {
  const index = order.findIndex((entry) => entry.traceId === trace.traceId);
  if (index === -1) {
    return;
  }
  drawer.open(order, index);
  markOpenTrace();
}

async function load(): Promise<void> {
  const listEl = document.getElementById("trace-list");
  if (!listEl) {
    return;
  }

  const { traces } = await request({
    tabId: inspectedTabId,
    type: "list-traces",
  });
  const list = traces ?? [];

  if (list.length === 0) {
    order = [];
    drawer.refresh(order);
    listEl.replaceChildren(el("p", "empty list-empty", EMPTY_LIST));
    return;
  }

  let rendered: TraceListRender;
  if (groupBySession) {
    const { sessions } = await request({
      tabId: inspectedTabId,
      type: "list-sessions",
    });
    rendered = renderGroupedList(list, sessions ?? [], openTrace);
  } else {
    rendered = renderFlatList(list, openTrace);
  }

  ({ order } = rendered);
  listEl.replaceChildren(...rendered.rows);
  drawer.refresh(order);
  markOpenTrace();
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

document
  .getElementById("group-by-session")
  ?.addEventListener("click", (event) => {
    groupBySession = !groupBySession;
    (event.currentTarget as HTMLElement).setAttribute(
      "aria-pressed",
      String(groupBySession)
    );
    load().catch(console.error);
  });

document.getElementById("refresh")?.addEventListener("click", () => {
  load().catch(console.error);
});

document.getElementById("clear")?.addEventListener("click", () => {
  (async () => {
    await request({ tabId: inspectedTabId, type: "clear-traces" });
    drawer.close();
    await load();
  })().catch(console.error);
});

document.getElementById("export")?.addEventListener("click", () => {
  (async () => {
    const { spans } = await request({
      tabId: inspectedTabId,
      type: "export-traces",
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
  if (msg.type !== TRACES_UPDATED) {
    return;
  }
  if (msg.tabId !== undefined && msg.tabId !== inspectedTabId) {
    return;
  }
  scheduleRefresh();
});

showScope();
load().catch(console.error);
