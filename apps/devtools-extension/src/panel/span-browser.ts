import type { StoredSpan } from "../storage/indexed-db.js";
import { el, iconButton, plural, type SpanView } from "./panel-utils.js";
import { renderSpanDetail } from "./span-detail.js";
import { groupSpans } from "./span-groups.js";
import { buildSpanList } from "./span-list.js";
import { buildSpanTimeline } from "./span-timeline.js";

const COLLAPSED_CHEVRON = "⌄";
const EXPANDED_CHEVRON = "⌃";

interface LabeledView {
  label: string;
  view: SpanView;
}

function buildViewToggle(entries: LabeledView[]): {
  element: HTMLElement;
  show: (index: number) => void;
} {
  const element = el("div", "view-toggle");
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", "Span view");

  const buttons = entries.map(({ label }, index) => {
    const button = iconButton(
      label,
      `Show spans as ${label.toLowerCase()}`,
      "toggle-btn"
    );
    button.addEventListener("click", () => show(index));
    element.append(button);
    return button;
  });

  function show(index: number): void {
    entries.forEach(({ view }, i) => {
      view.element.hidden = i !== index;
      buttons[i]?.setAttribute("aria-pressed", String(i === index));
    });
  }

  return { element, show };
}

/**
 * The span timeline (or list) stacked above the detail of whichever span is
 * selected. Stacking rather than sitting side by side leaves the detail the
 * full panel width, which matters in a side-docked DevTools window.
 *
 * The timeline leads, unlike MLflow's list-first default: traces here hold at
 * most a handful of spans, so time distribution is the more useful read. A
 * single-span trace skips the section altogether, since one bar filling the
 * whole axis says nothing its duration does not.
 */
export function buildSpanBrowser(spans: StoredSpan[]): HTMLElement {
  const container = el("div", "span-browser");
  const groups = groupSpans(spans);
  const detail = el("div", "span-browser-detail");

  const defaultSpan = groups.roots[0] ?? spans[0];
  if (!defaultSpan) {
    container.append(el("p", "empty", "No spans."));
    return container;
  }

  const select = (span: StoredSpan): void => {
    for (const { view } of views) {
      view.setActive(span.spanId);
    }
    detail.replaceChildren(renderSpanDetail(span, groups));
  };

  const views: LabeledView[] =
    spans.length > 1
      ? [
          { label: "Timeline", view: buildSpanTimeline(spans, groups, select) },
          { label: "List", view: buildSpanList(groups, select) },
        ]
      : [];

  if (views.length > 0) {
    const section = el("section", "spans-section");
    const header = el("div", "spans-header");
    const controls = el("div", "spans-controls");
    const body = el("div", "spans-body");
    for (const { view } of views) {
      body.append(view.element);
    }

    const toggle = buildViewToggle(views);
    const collapse = iconButton(EXPANDED_CHEVRON, "Collapse spans");
    collapse.setAttribute("aria-expanded", "true");
    collapse.addEventListener("click", () => {
      const expanded = collapse.getAttribute("aria-expanded") === "true";
      collapse.setAttribute("aria-expanded", String(!expanded));
      collapse.textContent = expanded ? COLLAPSED_CHEVRON : EXPANDED_CHEVRON;
      collapse.title = expanded ? "Expand spans" : "Collapse spans";
      body.hidden = expanded;
    });

    controls.append(toggle.element, collapse);
    header.append(
      el("h4", "spans-title", plural(spans.length, "span")),
      controls
    );
    section.append(header, body);
    container.append(section);
    toggle.show(0);
  }

  container.append(detail);
  select(defaultSpan);
  return container;
}
