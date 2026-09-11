import type { StoredSpan } from "../storage/indexed-db.js";
import {
  el,
  formatDuration,
  isErrorStatus,
  type SpanView,
} from "./panel-utils.js";
import type { SpanGroups } from "./span-groups.js";

const PERCENT = 100;
const TICK_TARGET_COUNT = 5;
const NICE_STEPS = [1, 2, 5, 10];

export interface TimelineRow {
  span: StoredSpan;
  /** Nesting level of the span, 0 for a root. */
  depth: number;
  /** Bar position within the trace window, as a percentage. */
  offsetPct: number;
  /** Bar length within the trace window, as a percentage. */
  widthPct: number;
}

export interface TimelineLayout {
  rows: TimelineRow[];
  /** Wall-clock span of the whole trace, earliest start to latest end. */
  totalMs: number;
}

/**
 * Bars are placed against the trace's own window rather than absolute time, so
 * a trace recorded at any moment fills the axis. Zero-duration spans keep a
 * width of 0 here and are widened to a visible tick by CSS `min-width`, which
 * leaves this geometry honest.
 */
export function timelineLayout(
  spans: StoredSpan[],
  groups: SpanGroups
): TimelineLayout {
  if (spans.length === 0) {
    return { rows: [], totalMs: 0 };
  }

  const start = Math.min(...spans.map((span) => span.startTimeMs));
  const end = Math.max(
    ...spans.map((span) => span.startTimeMs + span.durationMs)
  );
  const totalMs = end - start;

  const rows: TimelineRow[] = [];
  const walk = (siblings: StoredSpan[], depth: number): void => {
    for (const span of [...siblings].sort(
      (a, b) => a.startTimeMs - b.startTimeMs
    )) {
      rows.push({
        span,
        depth,
        offsetPct:
          totalMs > 0 ? ((span.startTimeMs - start) / totalMs) * PERCENT : 0,
        widthPct: totalMs > 0 ? (span.durationMs / totalMs) * PERCENT : 0,
      });
      walk(groups.childrenByParent.get(span.spanId) ?? [], depth + 1);
    }
  };
  walk(groups.roots, 0);

  return { rows, totalMs };
}

function niceStep(raw: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const base = raw / magnitude;
  const factor = NICE_STEPS.find((candidate) => candidate >= base) ?? 10;
  return factor * magnitude;
}

/**
 * Tick values in milliseconds, on a 1/2/5 step so labels read as round
 * numbers. Never finer than 1ms, which keeps sub-millisecond traces from
 * repeating the same rounded label on every tick.
 */
export function axisTicks(totalMs: number): number[] {
  if (totalMs <= 0) {
    return [];
  }
  const step = Math.max(1, niceStep(totalMs / TICK_TARGET_COUNT));
  const ticks: number[] = [];
  for (let tick = 0; tick <= totalMs; tick += step) {
    ticks.push(tick);
  }
  return ticks;
}

function renderAxis(totalMs: number): HTMLElement {
  const row = el("div", "timeline-axis-row");
  const axis = el("div", "timeline-axis");
  const ticks = axisTicks(totalMs);

  ticks.forEach((tick, index) => {
    const label = el("span", "timeline-tick", formatDuration(tick));
    // Edge labels hug the ends so they stay inside the track; the rest centre
    // on their gridline.
    if (index === 0) {
      label.style.left = "0";
    } else if (index === ticks.length - 1) {
      label.style.right = "0";
    } else {
      label.style.left = `${(tick / totalMs) * PERCENT}%`;
      label.classList.add("centered");
    }
    axis.append(label);
  });

  row.append(el("span", "timeline-axis-spacer"), axis);
  return row;
}

/**
 * A waterfall of one row per span: name and duration in a gutter, a
 * proportional bar in a shared track. Rows stay full width so the span detail
 * below can use the whole panel, which a sidebar tree of ten rows never
 * justified.
 */
export function buildSpanTimeline(
  spans: StoredSpan[],
  groups: SpanGroups,
  onSelect: (span: StoredSpan) => void
): SpanView {
  const { rows, totalMs } = timelineLayout(spans, groups);
  const element = el("div", "timeline");
  const ticks = axisTicks(totalMs);
  if (ticks.length > 1) {
    const step = ticks[1] ?? totalMs;
    element.style.setProperty("--tick-step", `${(step / totalMs) * PERCENT}%`);
  }
  element.append(renderAxis(totalMs));

  const rowList = el("div", "timeline-rows");
  for (const row of rows) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = isErrorStatus(row.span.status.code)
      ? "timeline-row has-error"
      : "timeline-row";
    button.dataset.spanId = row.span.spanId;
    button.style.setProperty("--depth", String(row.depth));
    // The gutter truncates long tool names, so keep the full one reachable.
    button.title = row.span.name;

    const bar = el("span", "timeline-bar");
    bar.style.left = `${row.offsetPct}%`;
    bar.style.width = `${row.widthPct}%`;
    const track = el("span", "timeline-track");
    track.append(bar);

    button.append(
      el("span", "timeline-name", row.span.name),
      el("span", "timeline-duration", formatDuration(row.span.durationMs)),
      track
    );
    button.addEventListener("click", () => onSelect(row.span));
    rowList.append(button);
  }
  element.append(rowList);

  return {
    element,
    setActive(spanId: string): void {
      for (const button of rowList.querySelectorAll<HTMLButtonElement>(
        ".timeline-row"
      )) {
        button.classList.toggle("active", button.dataset.spanId === spanId);
      }
    },
  };
}
