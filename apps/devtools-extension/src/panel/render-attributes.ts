import { GEN_AI } from "@web-ai-otel/core";
import type { StoredSpan } from "../storage/indexed-db.js";
import { el } from "./panel-utils.js";
import { renderFields, renderViewSection } from "./render-io.js";

const MLFLOW_INPUTS = "mlflow.spanInputs";
const MLFLOW_OUTPUTS = "mlflow.spanOutputs";

/** Shown in the Pretty/JSON panels — kept out of the attributes dump. */
const IO_ATTRIBUTE_KEYS = new Set([
  MLFLOW_INPUTS,
  MLFLOW_OUTPUTS,
  GEN_AI.INPUT_MESSAGES,
  GEN_AI.OUTPUT_MESSAGES,
  GEN_AI.TOOL_CALL_ARGUMENTS,
  GEN_AI.TOOL_CALL_RESULT,
]);

function tryParseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    // Attribute values are not always JSON.
  }
}

/** JSON strings stored as attribute values are expanded for the Pretty view. */
function prettyAttributeValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const parsed = tryParseJson(value);
  return parsed ?? value;
}

function prettyAttributes(
  attributes: Record<string, unknown>
): Record<string, unknown> {
  const pretty: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    pretty[key] = prettyAttributeValue(value);
  }
  return pretty;
}

function spanAttributes(span: StoredSpan): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(span.attributes).filter(
      ([key]) => !IO_ATTRIBUTE_KEYS.has(key)
    )
  );
}

export function renderAttributesTab(span: StoredSpan): HTMLElement {
  const attrs = spanAttributes(span);
  if (Object.keys(attrs).length === 0) {
    return el("p", "empty", "No attributes.");
  }

  const pretty = el("div", "io-body pretty");
  pretty.append(renderFields(prettyAttributes(attrs)));

  const json = el("pre", "io-body json", JSON.stringify(attrs, null, 2));

  return renderViewSection(undefined, pretty, json);
}
