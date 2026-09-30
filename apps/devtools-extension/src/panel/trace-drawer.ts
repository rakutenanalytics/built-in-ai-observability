import type { StoredSpan, TraceSummary } from "../storage/indexed-db.js";
import { contextUtilizationLabel } from "./context-meta.js";
import {
  el,
  formatDuration,
  iconButton,
  isErrorStatus,
  metaList,
  plural,
  shortId,
} from "./panel-utils.js";
import { buildSpanBrowser } from "./span-browser.js";
import { formatDateTime } from "./time-format.js";

export interface TraceDrawer {
  close: () => void;
  /** Shows `traces[index]`, replacing whatever the drawer held before. */
  open: (traces: TraceSummary[], index: number) => void;
  openTraceId: () => string | undefined;
  /**
   * Keeps an open drawer in step with a reloaded list: the trace may have
   * grown spans, moved position, or disappeared entirely.
   */
  refresh: (traces: TraceSummary[]) => void;
}

const CLOSE_ANIMATION_MS = 260;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
    ["Started", formatDateTime(trace.startTimeMs)],
    ["Origin", trace.origin],
    [
      "Tool calls",
      trace.toolCallCount > 0 ? String(trace.toolCallCount) : undefined,
    ],
    ["URL", trace.url],
  ]);
}

/**
 * Trace detail as a right slide-in sheet over the list. The dimmed list peek
 * signals master/detail navigation without squeezing prompts into a side column.
 */
export function createTraceDrawer(
  host: HTMLElement,
  loadSpans: (trace: TraceSummary) => Promise<StoredSpan[]>
): TraceDrawer {
  let traces: TraceSummary[] = [];
  let index = -1;
  let renderedSpanCount = -1;
  let restoreFocusTo: HTMLElement | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const backdrop = el("div", "drawer-backdrop");
  backdrop.hidden = true;

  const scrim = document.createElement("button");
  scrim.type = "button";
  scrim.className = "drawer-scrim";
  scrim.setAttribute("aria-label", "Close trace detail");

  const panel = el("div", "drawer");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "Trace detail");
  panel.tabIndex = -1;

  const previous = iconButton("←", "Previous trace (Left arrow)");
  const next = iconButton("→", "Next trace (Right arrow)");
  const close = iconButton("✕", "Close trace");
  const title = el("h2", "drawer-title");
  const summary = el("p", "drawer-summary");
  const body = el("div", "drawer-body");

  const nav = el("div", "drawer-nav");
  nav.append(previous, next);
  const header = el("div", "drawer-header");
  header.append(nav, title, summary, close);
  panel.append(header, body);
  backdrop.append(scrim, panel);
  host.append(backdrop);

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDrawer();
      return;
    }
    if (event.key === "ArrowLeft" && index > 0) {
      event.preventDefault();
      show(index - 1);
      return;
    }
    if (event.key === "ArrowRight" && index < traces.length - 1) {
      event.preventDefault();
      show(index + 1);
    }
  }

  function finishClose(): void {
    if (closeTimer !== undefined) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
    backdrop.hidden = true;
    backdrop.classList.remove("is-open");
    index = -1;
    renderedSpanCount = -1;
    body.replaceChildren();
    document.removeEventListener("keydown", onKeyDown);
    restoreFocusTo?.focus();
    restoreFocusTo = null;
  }

  function closeDrawer(): void {
    if (backdrop.hidden) {
      return;
    }
    backdrop.classList.remove("is-open");
    if (prefersReducedMotion()) {
      finishClose();
      return;
    }
    closeTimer = setTimeout(finishClose, CLOSE_ANIMATION_MS);
  }

  function openBackdrop(): void {
    backdrop.hidden = false;
    if (prefersReducedMotion()) {
      backdrop.classList.add("is-open");
      return;
    }
    requestAnimationFrame(() => {
      backdrop.classList.add("is-open");
    });
  }

  function render(trace: TraceSummary): void {
    title.textContent = trace.rootSpanName;
    title.classList.toggle("has-error", isErrorStatus(trace.statusCode));
    summary.textContent = traceSummaryLine(trace);
    previous.disabled = index <= 0;
    next.disabled = index >= traces.length - 1;

    renderedSpanCount = trace.spanCount;
    body.replaceChildren(traceMeta(trace), el("p", "empty", "Loading spans…"));

    // A later navigation may have replaced this trace mid-load.
    const isCurrent = () => traces[index]?.traceId === trace.traceId;
    const showError = (err: unknown): void => {
      body.replaceChildren(
        traceMeta(trace),
        el("p", "empty error", err instanceof Error ? err.message : String(err))
      );
    };

    loadSpans(trace)
      .then((spans) => {
        if (!isCurrent()) {
          return;
        }
        // Rendering a span whose attributes are malformed must surface the
        // failure, not leave the drawer stuck on "Loading spans…".
        try {
          body.replaceChildren(traceMeta(trace), buildSpanBrowser(spans));
        } catch (err) {
          showError(err);
        }
      })
      .catch((err: unknown) => {
        if (isCurrent()) {
          showError(err);
        }
      });
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
  scrim.addEventListener("click", closeDrawer);

  return {
    close: closeDrawer,
    open(nextTraces: TraceSummary[], nextIndex: number): void {
      if (closeTimer !== undefined) {
        clearTimeout(closeTimer);
        closeTimer = undefined;
      }
      traces = nextTraces;
      const wasClosed = backdrop.hidden;
      if (wasClosed) {
        restoreFocusTo = document.activeElement as HTMLElement | null;
        document.addEventListener("keydown", onKeyDown);
        openBackdrop();
      }
      show(nextIndex);
      panel.focus();
    },
    openTraceId(): string | undefined {
      return backdrop.hidden ? undefined : traces[index]?.traceId;
    },
    refresh(nextTraces: TraceSummary[]): void {
      if (backdrop.hidden) {
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
  };
}
