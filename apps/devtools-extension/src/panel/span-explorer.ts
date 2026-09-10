import type { StoredSpan } from "../storage/indexed-db.js";
import { spanInputs, spanOutputs } from "./message-preview.js";
import {
  buildTabs,
  el,
  formatDuration,
  formatTime,
  type MetaEntry,
  metaList,
} from "./panel-utils.js";
import { renderAttributesTab } from "./render-attributes.js";
import { renderSpanIo } from "./render-io.js";

const SPAN_STATUS_ERROR = 2;

interface SpanGroups {
  roots: StoredSpan[];
  childrenByParent: Map<string, StoredSpan[]>;
}

function groupSpans(spans: StoredSpan[]): SpanGroups {
  const byId = new Set(spans.map((span) => span.spanId));
  const childrenByParent = new Map<string, StoredSpan[]>();
  const roots: StoredSpan[] = [];

  for (const span of spans) {
    if (span.parentSpanId && byId.has(span.parentSpanId)) {
      const list = childrenByParent.get(span.parentSpanId) ?? [];
      list.push(span);
      childrenByParent.set(span.parentSpanId, list);
    } else {
      roots.push(span);
    }
  }
  return { roots, childrenByParent };
}

function renderCompactNode(
  span: StoredSpan,
  groups: SpanGroups,
  onSelect: (span: StoredSpan) => void
): HTMLElement {
  const li = el("li", "span-node-compact");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className =
    span.status.code === SPAN_STATUS_ERROR
      ? "span-node-btn has-error"
      : "span-node-btn";
  btn.dataset.spanId = span.spanId;
  btn.append(
    el("span", "span-node-name", span.name),
    el("span", "span-node-duration", formatDuration(span.durationMs))
  );
  btn.addEventListener("click", () => onSelect(span));
  li.append(btn);

  const children = groups.childrenByParent.get(span.spanId);
  if (children?.length) {
    const ul = el("ul", "span-tree compact");
    for (const child of children) {
      ul.append(renderCompactNode(child, groups, onSelect));
    }
    li.append(ul);
  }
  return li;
}

function renderIoTab(span: StoredSpan): HTMLElement {
  const inputs = spanInputs(span.attributes);
  const outputs = spanOutputs(span.attributes);
  return renderSpanIo(inputs, outputs) ?? el("p", "empty", "Nothing recorded.");
}

function renderEventsTab(span: StoredSpan): HTMLElement {
  const container = el("div", "events-list");
  for (const event of span.events) {
    container.append(
      el(
        "pre",
        "attrs",
        `${event.name} ${JSON.stringify(event.attributes ?? {}, null, 2)}`
      )
    );
  }
  return container;
}

/**
 * The detail pane for exactly one selected span — never more than one.
 * Inputs/Outputs and Attributes live in separate tabs, the way MLflow splits
 * them, so a span with a long attribute dump doesn't push its preview out of
 * view.
 */
function renderSpanDetail(span: StoredSpan): HTMLElement {
  const container = el("div", "span-detail");
  const heading = document.createElement("h3");
  heading.className = "span-detail-name";
  heading.textContent = span.name;
  container.append(heading);

  const metaEntries: MetaEntry[] = [
    ["Duration", formatDuration(span.durationMs)],
    ["Started", formatTime(span.startTimeMs)],
  ];
  if (span.status.code === SPAN_STATUS_ERROR) {
    metaEntries.push(["Error", span.status.message ?? "unknown"]);
  }
  container.append(metaList(metaEntries));

  container.append(
    buildTabs([
      { label: "Inputs / Outputs", content: renderIoTab(span) },
      { label: "Attributes", content: renderAttributesTab(span) },
      ...(span.events.length > 0
        ? [{ label: "Events", content: renderEventsTab(span) }]
        : []),
    ])
  );

  return container;
}

/**
 * A compact, clickable span tree beside a detail pane for whichever span is
 * selected — mirrors MLflow's span sidebar, so a shallow trace does not show
 * the same preview twice just because it has two spans. The root span is
 * selected by default, so opening a trace still leads with its preview.
 */
export function buildSpanExplorer(spans: StoredSpan[]): HTMLElement {
  const groups = groupSpans(spans);
  const explorer = el("div", "span-explorer");
  const tree = el("div", "span-explorer-tree");
  const detail = el("div", "span-explorer-detail");

  const selectSpan = (span: StoredSpan): void => {
    for (const btn of tree.querySelectorAll<HTMLButtonElement>(
      ".span-node-btn"
    )) {
      btn.classList.toggle("active", btn.dataset.spanId === span.spanId);
    }
    detail.replaceChildren(renderSpanDetail(span));
  };

  const list = el("ul", "span-tree compact root");
  for (const root of groups.roots) {
    list.append(renderCompactNode(root, groups, selectSpan));
  }
  tree.append(list);
  explorer.append(tree, detail);

  const defaultSpan = groups.roots[0] ?? spans[0];
  if (defaultSpan) {
    selectSpan(defaultSpan);
  } else {
    detail.replaceChildren(el("p", "empty", "No spans."));
  }

  return explorer;
}
