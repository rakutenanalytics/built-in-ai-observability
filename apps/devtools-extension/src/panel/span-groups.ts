import type { StoredSpan } from "../storage/indexed-db.js";
import { contextUtilizationFromAttributes } from "./context-meta.js";

export interface SpanGroups {
  roots: StoredSpan[];
  childrenByParent: Map<string, StoredSpan[]>;
}

export function groupSpans(spans: StoredSpan[]): SpanGroups {
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

export function descendantSpans(
  spanId: string,
  childrenByParent: Map<string, StoredSpan[]>
): StoredSpan[] {
  const descendants: StoredSpan[] = [];
  for (const child of childrenByParent.get(spanId) ?? []) {
    descendants.push(child, ...descendantSpans(child.spanId, childrenByParent));
  }
  return descendants;
}

/**
 * `invoke_agent` roots often predate the attribute on the span itself, so fall
 * back to the latest descendant that recorded context usage after a turn.
 */
export function spanContextUtilization(
  span: StoredSpan,
  groups: SpanGroups
): number | undefined {
  const own = contextUtilizationFromAttributes(span.attributes);
  if (own !== undefined) {
    return own;
  }

  let latest: StoredSpan | undefined;
  for (const child of descendantSpans(span.spanId, groups.childrenByParent)) {
    if (contextUtilizationFromAttributes(child.attributes) === undefined) {
      continue;
    }
    if (!latest || child.startTimeMs >= latest.startTimeMs) {
      latest = child;
    }
  }
  return latest
    ? contextUtilizationFromAttributes(latest.attributes)
    : undefined;
}
