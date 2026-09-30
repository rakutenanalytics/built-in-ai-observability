import type { StoredSpan } from "../storage/indexed-db.js";
import {
  el,
  formatDuration,
  isErrorStatus,
  type SpanView,
} from "./panel-utils.js";
import type { SpanGroups } from "./span-groups.js";

function renderNode(
  span: StoredSpan,
  groups: SpanGroups,
  onSelect: (span: StoredSpan) => void
): HTMLElement {
  const li = el("li", "span-node-compact");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = isErrorStatus(span.status.code)
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
      ul.append(renderNode(child, groups, onSelect));
    }
    li.append(ul);
  }
  return li;
}

/**
 * The plain nested list of spans, kept as an alternative to the timeline for
 * traces deep enough that hierarchy reads better than time.
 */
export function buildSpanList(
  groups: SpanGroups,
  onSelect: (span: StoredSpan) => void
): SpanView {
  const element = el("ul", "span-tree compact root");
  for (const root of groups.roots) {
    element.append(renderNode(root, groups, onSelect));
  }

  return {
    element,
    setActive(spanId: string): void {
      for (const btn of element.querySelectorAll<HTMLButtonElement>(
        ".span-node-btn"
      )) {
        btn.classList.toggle("active", btn.dataset.spanId === spanId);
      }
    },
  };
}
