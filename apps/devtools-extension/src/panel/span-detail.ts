import type { StoredSpan } from "../storage/indexed-db.js";
import { formatContextUtilization } from "./context-meta.js";
import { spanInputs, spanOutputs } from "./message-preview.js";
import {
  buildTabs,
  el,
  formatDuration,
  formatTime,
  isErrorStatus,
  type MetaEntry,
  metaList,
} from "./panel-utils.js";
import { renderAttributesTab } from "./render-attributes.js";
import { renderSpanIo } from "./render-io.js";
import { type SpanGroups, spanContextUtilization } from "./span-groups.js";

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
export function renderSpanDetail(
  span: StoredSpan,
  groups: SpanGroups
): HTMLElement {
  const container = el("div", "span-detail");
  const heading = document.createElement("h3");
  heading.className = "span-detail-name";
  heading.textContent = span.name;
  container.append(heading);

  const context = formatContextUtilization(
    spanContextUtilization(span, groups)
  );
  const metaEntries: MetaEntry[] = [
    ["Duration", formatDuration(span.durationMs)],
    ["Started", formatTime(span.startTimeMs)],
    ["Context", context],
  ];
  if (isErrorStatus(span.status.code)) {
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
