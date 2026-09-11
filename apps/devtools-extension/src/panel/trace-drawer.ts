import type { StoredSpan, TraceSummary } from "../storage/indexed-db.js";
import { contextUtilizationLabel } from "./context-meta.js";
import {
  el,
  formatDuration,
  formatTime,
  iconButton,
  isErrorStatus,
  metaList,
  plural,
  shortId,
} from "./panel-utils.js";
import { buildSpanBrowser } from "./span-browser.js";

export interface TraceDrawer {
  /** Shows `traces[index]`, replacing whatever the drawer held before. */
  open(traces: TraceSummary[], index: number): void;
  close(): void;
  /**
   * Keeps an open drawer in step with a reloaded list: the trace may have
   * grown spans, moved position, or disappeared entirely.
   */
  refresh(traces: TraceSummary[]): void;
  openTraceId(): string | undefined;
}

function traceSummaryLine(trace: TraceSummary): string {
  const parts = [
    formatDuration(trace.durationMs),
    plural(trace.spanCount, "span"),
  ];
  const context = contextUtilizationLabel(trace);
  if (context) {
    parts.push(`${context} context`);
  }
  return `${isErrorStatus(trace.statusCode) ? "⚠" : "✓"} ${parts.join(" · ")}`;
}

function traceMeta(trace: TraceSummary): HTMLElement {
  return metaList([
    ["Trace", shortId(trace.traceId)],
    ["Session", trace.conversationId && shortId(trace.conversationId)],
    ["Started", formatTime(trace.startTimeMs)],
    ["Origin", trace.origin],
    [
      "Tool calls",
      trace.toolCallCount > 0 ? String(trace.toolCallCount) : undefined,
    ],
    ["URL", trace.url],
  ]);
}

/**
 * The trace detail as an overlay rather than a third column. Covering the
 * whole panel is deliberate: at side-docked DevTools widths, leaving part of
 * the list visible would squeeze the prompts and responses back into a ribbon,
 * which is the problem the overlay exists to solve.
 */
export function createTraceDrawer(
  host: HTMLElement,
  loadSpans: (trace: TraceSummary) => Promise<StoredSpan[]>
): TraceDrawer {
  let traces: TraceSummary[] = [];
  let index = -1;
  let renderedSpanCount = -1;
  let restoreFocusTo: HTMLElement | null = null;

  const element = el("div", "drawer");
  element.setAttribute("role", "dialog");
  element.setAttribute("aria-modal", "true");
  element.setAttribute("aria-label", "Trace detail");
  element.tabIndex = -1;
  element.hidden = true;

  const previous = iconButton("←", "Previous trace");
  const next = iconButton("→", "Next trace");
  const close = iconButton("✕", "Close trace");
  const title = el("h2", "drawer-title");
  const summary = el("p", "drawer-summary");
  const body = el("div", "drawer-body");

  const nav = el("div", "drawer-nav");
  nav.append(previous, next);
  const header = el("div", "drawer-header");
  header.append(nav, title, summary, close);
  element.append(header, body);
  host.append(element);

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDrawer();
    }
  }

  function closeDrawer(): void {
    element.hidden = true;
    index = -1;
    renderedSpanCount = -1;
    body.replaceChildren();
    document.removeEventListener("keydown", onKeyDown);
    restoreFocusTo?.focus();
    restoreFocusTo = null;
  }

  function render(trace: TraceSummary): void {
    title.textContent = trace.rootSpanName;
    title.classList.toggle("has-error", isErrorStatus(trace.statusCode));
    summary.textContent = traceSummaryLine(trace);
    previous.disabled = index <= 0;
    next.disabled = index >= traces.length - 1;

    renderedSpanCount = trace.spanCount;
    body.replaceChildren(traceMeta(trace), el("p", "empty", "Loading spans…"));
    loadSpans(trace)
      .then((spans) => {
        // A later navigation may have replaced this trace mid-load.
        if (traces[index]?.traceId !== trace.traceId) {
          return;
        }
        body.replaceChildren(traceMeta(trace), buildSpanBrowser(spans));
      })
      .catch(console.error);
  }

  function show(nextIndex: number): void {
    const trace = traces[nextIndex];
    if (!trace) {
      return;
    }
    index = nextIndex;
    render(trace);
  }

  previous.addEventListener("click", () => show(index - 1));
  next.addEventListener("click", () => show(index + 1));
  close.addEventListener("click", closeDrawer);

  return {
    open(nextTraces: TraceSummary[], nextIndex: number): void {
      traces = nextTraces;
      if (element.hidden) {
        restoreFocusTo = document.activeElement as HTMLElement | null;
        document.addEventListener("keydown", onKeyDown);
      }
      element.hidden = false;
      show(nextIndex);
      element.focus();
    },
    close: closeDrawer,
    refresh(nextTraces: TraceSummary[]): void {
      if (element.hidden) {
        traces = nextTraces;
        return;
      }
      const openId = traces[index]?.traceId;
      traces = nextTraces;
      const movedTo = nextTraces.findIndex((t) => t.traceId === openId);
      if (movedTo === -1) {
        closeDrawer();
        return;
      }
      index = movedTo;
      const trace = nextTraces[movedTo];
      // Re-render only when spans arrived, so a background refresh doesn't
      // throw away the span the user is reading.
      if (trace && trace.spanCount !== renderedSpanCount) {
        render(trace);
      } else if (trace) {
        summary.textContent = traceSummaryLine(trace);
        previous.disabled = index <= 0;
        next.disabled = index >= nextTraces.length - 1;
      }
    },
    openTraceId(): string | undefined {
      return element.hidden ? undefined : traces[index]?.traceId;
    },
  };
}
