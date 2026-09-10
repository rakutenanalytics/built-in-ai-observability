import type {
  IoPayload,
  IoView,
  PrettyMessage,
  PrettyToolCall,
} from "./message-preview.js";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

export function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

export function renderFields(fields: Record<string, unknown>): HTMLElement {
  const list = el("dl", "field-list");
  for (const [key, value] of Object.entries(fields)) {
    list.append(
      el("dt", "field-key", key),
      el("dd", "field-value", formatValue(value))
    );
  }
  return list;
}

function renderToolCall(call: PrettyToolCall): HTMLElement {
  const card = el("div", "tool-call");
  card.append(el("div", "tool-call-name", call.name));
  const fields = objectFields(call.arguments);
  if (fields) {
    card.append(renderFields(fields));
  } else if (call.arguments !== undefined) {
    card.append(el("pre", "tool-call-raw", formatValue(call.arguments)));
  }
  return card;
}

function objectFields(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return;
}

function renderMessageCard(message: PrettyMessage): HTMLElement {
  const card = el("article", `message-card role-${message.role}`);
  card.append(el("header", "message-role", message.title));

  if (message.toolCalls?.length) {
    card.append(el("div", "message-subtitle", "Tool calls"));
    for (const call of message.toolCalls) {
      card.append(renderToolCall(call));
    }
  }

  if (message.text) {
    card.append(el("div", "message-content", message.text));
  }
  if (message.fields) {
    card.append(renderFields(message.fields));
  }

  return card;
}

function renderPrettyBody(payload: IoPayload): HTMLElement {
  const body = el("div", "io-body pretty");
  if (payload.fields && payload.messages.length === 0) {
    body.append(renderFields(payload.fields));
    return body;
  }
  for (const message of payload.messages) {
    body.append(renderMessageCard(message));
  }
  return body;
}

function renderJsonBody(payload: IoPayload): HTMLElement {
  let text = payload.json;
  try {
    text = JSON.stringify(JSON.parse(payload.json), null, 2);
  } catch {
    // Leave the raw string when it is not JSON.
  }
  return el("pre", "io-body json", text);
}

/** One framed block with a Pretty/JSON selector — shared by I/O and attributes. */
export function renderViewSection(
  label: string,
  prettyBody: HTMLElement,
  jsonBody: HTMLElement
): HTMLElement {
  const section = el("section", "io-section");
  const header = el("div", "io-header");
  header.append(el("h4", "io-label", label));

  const select = document.createElement("select");
  select.className = "io-view";
  select.setAttribute("aria-label", `${label} view`);
  for (const view of ["pretty", "json"] as const) {
    const option = document.createElement("option");
    option.value = view;
    option.textContent = view === "pretty" ? "Pretty" : "JSON";
    select.append(option);
  }
  select.value = "pretty";
  header.append(select);
  section.append(header);

  jsonBody.hidden = true;
  section.append(prettyBody, jsonBody);

  select.addEventListener("change", () => {
    const view = select.value as IoView;
    prettyBody.hidden = view !== "pretty";
    jsonBody.hidden = view !== "json";
  });

  return section;
}

function renderIoSection(
  label: "Inputs" | "Outputs",
  payload: IoPayload
): HTMLElement {
  return renderViewSection(
    label,
    renderPrettyBody(payload),
    renderJsonBody(payload)
  );
}

export function renderSpanIo(
  inputs?: IoPayload,
  outputs?: IoPayload
): HTMLElement | undefined {
  if (!(inputs || outputs)) {
    return;
  }

  const container = el("div", "span-io");
  if (inputs) {
    container.append(renderIoSection("Inputs", inputs));
  }
  if (outputs) {
    container.append(renderIoSection("Outputs", outputs));
  }
  return container;
}
