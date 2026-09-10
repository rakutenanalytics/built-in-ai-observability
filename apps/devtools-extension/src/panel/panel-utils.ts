const MS_PER_SECOND = 1000;
const SHORT_ID_LENGTH = 8;

export function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    // textContent throughout: span names, origins and prompts come from the page.
    node.textContent = text;
  }
  return node;
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

export function formatDuration(ms: number): string {
  if (ms < MS_PER_SECOND) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / MS_PER_SECOND).toFixed(2)}s`;
}

export function shortId(id: string): string {
  return id.slice(0, SHORT_ID_LENGTH);
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Only shown when tools were actually used, so plain turns stay uncluttered. */
export function toolSuffix(count: number): string {
  return count > 0 ? ` · ${plural(count, "tool call")}` : "";
}

export type MetaEntry = [label: string, value: string | undefined];

export function metaList(entries: MetaEntry[]): HTMLElement {
  const ul = el("ul", "detail-meta");
  for (const [label, value] of entries) {
    if (value !== undefined) {
      ul.append(el("li", "meta", `${label}: ${value}`));
    }
  }
  return ul;
}

export interface TabDef {
  label: string;
  content: HTMLElement;
}

/**
 * A minimal ARIA tabs widget: buttons that toggle which panel is visible.
 * Written by hand rather than pulling in a UI framework for one widget —
 * the same reasoning behind the Pretty/JSON select in render-io.ts.
 */
export function buildTabs(tabs: TabDef[]): HTMLElement {
  const container = el("div", "detail-tabs");
  const tabList = el("div", "tab-list");
  tabList.setAttribute("role", "tablist");
  const panels = el("div", "tab-panels");
  const buttons: HTMLButtonElement[] = [];

  const select = (index: number): void => {
    tabs.forEach((tab, i) => {
      const isActive = i === index;
      buttons[i]?.setAttribute("aria-selected", String(isActive));
      tab.content.hidden = !isActive;
    });
  };

  tabs.forEach((tab, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tab-button";
    button.textContent = tab.label;
    button.setAttribute("role", "tab");
    button.addEventListener("click", () => select(index));
    buttons.push(button);
    tabList.append(button);

    tab.content.setAttribute("role", "tabpanel");
    panels.append(tab.content);
  });

  container.append(tabList, panels);
  select(0);
  return container;
}
